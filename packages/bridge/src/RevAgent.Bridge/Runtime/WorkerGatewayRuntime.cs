using System.Reflection;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Updates;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// The RBP data plane as one owned object graph inside the worker process:
/// the journal store, the add-in discovery/routing surface, and the connection
/// coordinator that owns the Gateway binding, invocation dispatch, and the
/// standing document-context watcher.
/// </summary>
/// <remarks>
/// <para>
/// Construction is the fail-closed gate. Everything a connection needs — the
/// canonical journal at the state root, the production resume-token
/// protector, the enrollment seam, the routed dispatch surface — is built
/// before the runtime exists. A precondition that cannot be met throws out of
/// <see cref="CreateProduction"/> and no half-built runtime is ever handed to
/// the host.
/// </para>
/// <para>
/// Nothing here touches the network. <see cref="RunAsync"/> is what starts
/// connecting, and it inherits the coordinator's existing full-jitter backoff
/// and frozen retry pauses, so an offline machine never blocks SCM start and
/// an unenrolled machine never retry-storms.
/// </para>
/// </remarks>
internal sealed class WorkerGatewayRuntime : IAsyncDisposable
{
    /// <summary>
    /// The carrier producer's constructor sweep is recovery-only.  This pump
    /// keeps the seven-day terminal-fenced expiry policy alive for a long-lived
    /// worker without making any send path a cleanup authority.
    /// </summary>
    internal static readonly TimeSpan DefaultCarrierSweepInterval =
        TimeSpan.FromHours(1);

    private readonly RbpConnectionCoordinator _coordinator;
    private readonly RbpJournalStore? _ownedJournal;
    private readonly RbpArtifactCarrierProducer? _carrierProducer;
    private readonly TimeSpan _carrierSweepInterval;
    private int _disposed;

    internal WorkerGatewayRuntime(
        RbpConnectionCoordinator coordinator,
        RbpJournalStore? ownedJournal = null,
        RbpArtifactCarrierProducer? carrierProducer = null,
        TimeSpan? carrierSweepInterval = null)
    {
        _coordinator = coordinator ??
            throw new ArgumentNullException(nameof(coordinator));
        _ownedJournal = ownedJournal;
        _carrierProducer = carrierProducer;
        _carrierSweepInterval =
            carrierSweepInterval ?? DefaultCarrierSweepInterval;
        if (_carrierSweepInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(carrierSweepInterval));
        }
    }

    internal RbpConnectionCoordinator Coordinator => _coordinator;

    /// <summary>
    /// Composes the production runtime at the canonical install layout.
    /// </summary>
    internal static WorkerGatewayRuntime CreateProduction(
        BridgeInstallLayout layout,
        ResolvedBridgeConfiguration configuration,
        RbpJournalOpenOptions? journalOptions = null,
        Action<AddinDiscoveryEvidence>? onDiscovered = null,
        Action<string>? onDispatchDiagnostic = null,
        Func<RbpConnectionFailureObservation, ValueTask>?
            onConnectionFailureObservation = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(configuration);

        string bridgeVersion = GetBridgeVersion();
        RbpJournalStore journal = WorkerGatewayComposition.OpenJournal(
            layout,
            WorkerResumeTokenProtector.CreateProduction(),
            journalOptions);
        try
        {
            var credentialClaims = new RbpCredentialClaimBinding(
                WorkerGatewayComposition.CreateEnrollmentStateProvider(
                    layout));
            RbpArtifactCarrierProducer? carrierProducer = null;
            try
            {
                carrierProducer = RbpArtifactCarrierProducer.CreateProduction(
                    layout.StateRoot,
                    journal);
            }
            catch (RbpArtifactCarrierException)
            {
                // A missing or unsafe spool never becomes a degraded carrier:
                // keep the existing inline-only posture and omit the carrier
                // capabilities from hello. The journal remains usable.
            }
            var transport = new AddinTcpTransport();
            var router = new AddinSessionRouter(transport);
            var catalog = new WorkerAddinSessionCatalog(
                new AddinDiscovery(transport),
                router,
                configuration,
                () => BridgeDeviceCredentialProvider.CreateProduction(layout),
                async (rsid, token) =>
                    (await journal
                        .GetStoredSessionAsync(rsid, token)
                        .ConfigureAwait(false))?.LocalSessionKey,
                bridgeVersion,
                hostname: null,
                onDiscovered: onDiscovered,
                credentialClaims: credentialClaims);

            RbpConnectionCoordinator coordinator =
                WorkerGatewayComposition.CreateCoordinator(
                    new WorkerGatewayServices(
                        WorkerGatewayComposition.CreateConnectionCycleFactory(
                            credentialClaims),
                        journal,
                        catalog,
                        new RbpConnectionCoordinatorOptions(
                            configuration.GatewayUri,
                            RbpHelloProfile.Production(
                                bridgeVersion,
                                Array.Empty<string>(),
                                carrierProducer is null
                                    ? null
                                    : RbpArtifactCarrierProducer
                                        .ConnectionCapabilities),
                            CredentialClaimInvalidator: credentialClaims,
                            SessionRouteBindingAuthority: catalog),
                        new WorkerAddinDispatchSurface(router, catalog, catalog),
                        Clock: null,
                        Random: null,
                        OnDispatchDiagnostic: onDispatchDiagnostic,
                        OnConnectionFailureObservation:
                            onConnectionFailureObservation,
                        CarrierProducer: carrierProducer,
                        UpdateReports: new BridgeUpdateReportStore(layout)));

            return new WorkerGatewayRuntime(
                coordinator,
                ownedJournal: journal,
                carrierProducer: carrierProducer);
        }
        catch
        {
            // A half-built runtime must never survive: release the machine-wide
            // single-writer journal lease before the failure propagates.
            journal.DisposeAsync().AsTask().GetAwaiter().GetResult();
            throw;
        }
    }

    /// <summary>
    /// Owns the connection for the lifetime of <paramref name="cancellationToken"/>.
    /// </summary>
    /// <remarks>
    /// The coordinator's own contract decides everything about retry. This
    /// method only guarantees that bounded maintenance never outlives the
    /// connection and that a coordinator fault reaches the caller intact —
    /// including <see cref="RbpCoordinatorErrorCode.NonDrainingConnectionAuthority"/>,
    /// which the host must turn into a process exit.
    /// </remarks>
    internal async Task RunAsync(CancellationToken cancellationToken)
    {
        using var backgroundCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task carrierSweep = _carrierProducer is null
            ? Task.CompletedTask
            : RunCarrierSweepAsync(backgroundCancellation.Token);
        try
        {
            await _coordinator.RunAsync(cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            backgroundCancellation.Cancel();
            await carrierSweep.ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        if (_ownedJournal is not null)
        {
            await _ownedJournal.DisposeAsync().ConfigureAwait(false);
        }
    }

    private async Task RunCarrierSweepAsync(CancellationToken cancellationToken)
    {
        RbpArtifactCarrierProducer producer = _carrierProducer!;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (_ownedJournal is not null)
                {
                    RbpJournalRetentionResult retained =
                        await _ownedJournal.ApplyRetentionAsync(
                            RbpJournalStore.MinimumRetentionPeriod,
                            cancellationToken)
                            .ConfigureAwait(false);
                    // Retention yields only journal-fenced, expired carriers.
                    // The sequential loop awaits this entire pass, so no two
                    // cleanup passes overlap and cancellation reaches the
                    // journal boundary before any next pass can begin.
                    if (retained.ExactReleasedCarriers.Count > 0)
                    {
                        producer.SweepExpired(retained.ExactReleasedCarriers);
                    }
                }
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (RbpArtifactCarrierException)
            {
                // A fenced spool cleanup error leaves evidence intact and is
                // retried later. It must not terminate a live connection.
            }
            catch (IOException)
            {
                // Same posture for transient filesystem contention.
            }
            catch (RbpJournalException)
            {
                // Retention is bounded maintenance. A failed sweep leaves the
                // replay plan intact and retries on the next serialized pass.
            }

            try
            {
                await Task.Delay(_carrierSweepInterval, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static string GetBridgeVersion()
    {
        Assembly assembly = Assembly.GetEntryAssembly() ??
            typeof(WorkerGatewayRuntime).Assembly;
        string version = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion ??
            assembly.GetName().Version?.ToString() ??
            "unknown";
        if (version.Length == 0)
        {
            return "unknown";
        }

        return version.Length <= 128 ? version : version[..128];
    }
}

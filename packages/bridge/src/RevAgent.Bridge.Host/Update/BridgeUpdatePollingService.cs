using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Contracts.Signing;

namespace RevAgent.Bridge.Host.Update;

internal sealed class BridgeUpdatePollingService : BackgroundService
{
    internal static readonly TimeSpan PollInterval = TimeSpan.FromMinutes(5);
    private const int MaximumManifestResponseBytes = 1024 * 1024;

    private readonly BridgeInstallLayout _layout;
    private readonly BridgeUpdateStateStore _stateStore;
    private readonly WorkerSupervisor _supervisor;
    private readonly IBridgeLog _log;
    private readonly TimeProvider _timeProvider;
    private readonly Func<HttpClient> _httpClientFactory;

    internal BridgeUpdatePollingService(
        BridgeInstallLayout layout,
        BridgeUpdateStateStore stateStore,
        WorkerSupervisor supervisor,
        IBridgeLog log,
        TimeProvider? timeProvider = null,
        Func<HttpClient>? httpClientFactory = null)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _supervisor = supervisor ?? throw new ArgumentNullException(nameof(supervisor));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _timeProvider = timeProvider ?? TimeProvider.System;
        _httpClientFactory = httpClientFactory ?? CreateHttpClient;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                BridgeUpdateResult? result = await CheckOnceAsync(stoppingToken)
                    .ConfigureAwait(false);
                if (result is not null)
                {
                    await TryLogAsync(
                        "information",
                        "bridge_update_checked",
                        $"Update version={result.Version}, sequence={result.ReleaseSequence}, " +
                        $"state={result.Disposition}, reason={result.Reason}.",
                        stoppingToken).ConfigureAwait(false);
                    if (result.BridgeApplied)
                    {
                        await _supervisor.RequestUpdateRestartAsync(stoppingToken)
                            .ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                await TryLogAsync(
                    "warning",
                    "bridge_update_check_failed",
                    "The signed Bridge update check failed closed.",
                    stoppingToken,
                    exception).ConfigureAwait(false);
            }

            try
            {
                await Task.Delay(PollInterval, _timeProvider, stoppingToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<BridgeUpdateResult?> CheckOnceAsync(
        CancellationToken cancellationToken)
    {
        if (!File.Exists(_layout.UpdateTrustedKeysPath) ||
            !File.Exists(_layout.ConfigurationPath))
        {
            return null;
        }

        using BridgeRuntimeCredentialState? credentialState =
            BridgeCredentialReader.CreateProduction(_layout).Load();
        BridgeDeviceCredential? credential = credentialState?.DeviceCredential;
        if (credentialState is null || credential is null)
        {
            return null;
        }

        ResolvedBridgeConfiguration configuration =
            BridgeConfigurationLoader.LoadFromCurrentEnvironment(
                _layout.ConfigurationPath);
        TrustedPublicKeyRing trustedKeys = LoadTrustedKeys(
            _layout.UpdateTrustedKeysPath);
        string sessionId = Guid.NewGuid().ToString("D");
        string tenantBinding = CreateTenantBinding(
            credentialState.MachineFingerprint,
            credential.DeviceId);
        var principal = new BridgeUpdatePrincipal(
            tenantBinding,
            credential.DeviceId,
            sessionId);

        using HttpClient http = _httpClientFactory();
        using var token = credential.DeviceToken.Clone();
        string revealedToken = token.Reveal();
        Uri manifestUri = CreateManifestUri(configuration.GatewayUri);
        using var request = new HttpRequestMessage(HttpMethod.Get, manifestUri);
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            revealedToken);
        request.Headers.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/json"));
        using HttpResponseMessage response = await http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        byte[] responseBytes = await ReadBoundedAsync(
            response.Content,
            MaximumManifestResponseBytes,
            cancellationToken).ConfigureAwait(false);
        JObject wrapper = JObject.Parse(new UTF8Encoding(false, true).GetString(responseBytes));
        RejectUnexpectedWrapperFields(wrapper);
        if (wrapper["manifest"] is not JObject manifest ||
            wrapper["signatureEnvelope"] is not JObject signature ||
            wrapper["deviceRing"]?.Type != JTokenType.Integer ||
            !int.TryParse(
                wrapper["deviceRing"]!.ToString(),
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out int deviceRing) ||
            deviceRing is < 0 or > 99)
        {
            throw new BridgeUpdateRejectedException(
                "invalid_manifest_response",
                "Authenticated update response shape is invalid.");
        }

        string installedVersion = await ResolveInstalledVersionAsync(cancellationToken)
            .ConfigureAwait(false);
        var artifacts = new AuthenticatedSessionArtifactSource(
            http,
            principal,
            manifestUri);
        var engine = new BridgeUpdateEngine(
            _layout,
            _stateStore,
            trustedKeys,
            artifacts,
            new SystemRevitProcessProbe(),
            installedVersion,
            _timeProvider);
        return await engine.ApplyAsync(
            new SignedBridgeUpdate(manifest, signature, principal, deviceRing),
            cancellationToken).ConfigureAwait(false);
    }

    internal static Uri CreateManifestUri(Uri gatewayUri)
    {
        ArgumentNullException.ThrowIfNull(gatewayUri);
        var builder = new UriBuilder(gatewayUri)
        {
            Scheme = gatewayUri.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase)
                ? Uri.UriSchemeHttps
                : gatewayUri.Scheme,
            Path = "/bridge/update/manifest",
            Query = string.Empty,
            Fragment = string.Empty,
        };
        if (!builder.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            throw new BridgeUpdateRejectedException(
                "invalid_update_endpoint",
                "Bridge update endpoint must use HTTPS.");
        }

        return builder.Uri;
    }

    internal static TrustedPublicKeyRing LoadTrustedKeys(string path)
    {
        JObject document = JObject.Parse(File.ReadAllText(path));
        JObject keys = document["trustedKeys"] as JObject ?? document;
        var loaded = new List<TrustedPublicKey>();
        foreach (JProperty property in keys.Properties())
        {
            if (property.Value is not JObject value ||
                value["publicKeyXml"]?.Type != JTokenType.String ||
                value["publicKeyFingerprint"]?.Type != JTokenType.String ||
                value["algorithm"]?.Type != JTokenType.String ||
                !string.Equals(
                    value.Value<string>("algorithm"),
                    DetachedSignatureContract.Algorithm,
                    StringComparison.Ordinal))
            {
                throw new BridgeUpdateRejectedException(
                    "invalid_trusted_keys",
                    "Update trusted-key document is invalid.");
            }

            loaded.Add(new TrustedPublicKey(
                property.Name,
                value.Value<string>("publicKeyXml")!,
                value.Value<string>("publicKeyFingerprint")!));
        }

        if (loaded.Count == 0)
        {
            throw new BridgeUpdateRejectedException(
                "trusted_keys_empty",
                "Update trusted-key document contains no keys.");
        }

        return TrustedPublicKeyRing.Create(loaded);
    }

    internal static string CreateTenantBinding(
        string machineFingerprint,
        string deviceId)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(
            machineFingerprint + "\0" + deviceId);
        return "tenant-bound-device-sha256:" +
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    private async Task<string> ResolveInstalledVersionAsync(
        CancellationToken cancellationToken)
    {
        BridgeUpdateState state = await _stateStore.ReadAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!string.IsNullOrEmpty(state.ActiveVersion))
        {
            return state.ActiveVersion;
        }

        string executable = WorkerExecutableResolver.Resolve(_layout).ExecutablePath;
        string version = FileVersionInfo.GetVersionInfo(executable).ProductVersion ??
            FileVersionInfo.GetVersionInfo(executable).FileVersion ??
            "installed";
        int metadata = version.IndexOf('+');
        if (metadata >= 0)
        {
            version = version[..metadata];
        }

        UpdatePathPolicy.ValidateVersion(version);
        return version;
    }

    private static async Task<byte[]> ReadBoundedAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        await using Stream source = await content.ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var target = new MemoryStream();
        var buffer = new byte[81920];
        while (true)
        {
            int read = await source.ReadAsync(buffer, cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                return target.ToArray();
            }

            if (target.Length + read > maximumBytes)
            {
                throw new BridgeUpdateRejectedException(
                    "manifest_response_too_large",
                    "Update manifest response exceeded its byte limit.");
            }

            target.Write(buffer, 0, read);
        }
    }

    private static void RejectUnexpectedWrapperFields(JObject wrapper)
    {
        string[] expected = ["manifest", "signatureEnvelope", "deviceRing"];
        if (wrapper.Properties().Count() != expected.Length ||
            wrapper.Properties().Any(
                property => !expected.Contains(property.Name, StringComparer.Ordinal)))
        {
            throw new BridgeUpdateRejectedException(
                "invalid_manifest_response",
                "Authenticated update response contains unexpected fields.");
        }
    }

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        CancellationToken cancellationToken,
        Exception? exception = null)
    {
        try
        {
            await _log.WriteAsync(
                level,
                eventId,
                "host.update",
                message,
                exception,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // Persisted update state remains authoritative.
        }
    }

    private static HttpClient CreateHttpClient() => new(
        new HttpClientHandler { UseProxy = true, AllowAutoRedirect = false },
        disposeHandler: true)
    {
        Timeout = TimeSpan.FromSeconds(45),
    };
}

internal sealed class AuthenticatedSessionArtifactSource : IBridgeUpdateArtifactSource
{
    private readonly HttpClient _http;
    private readonly BridgeUpdatePrincipal _principal;
    private readonly Uri _manifestUri;

    internal AuthenticatedSessionArtifactSource(
        HttpClient http,
        BridgeUpdatePrincipal principal,
        Uri manifestUri)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _principal = principal ?? throw new ArgumentNullException(nameof(principal));
        _manifestUri = manifestUri ?? throw new ArgumentNullException(nameof(manifestUri));
    }

    public async ValueTask<Stream> OpenReadAsync(
        Uri artifactUri,
        BridgeUpdatePrincipal principal,
        CancellationToken cancellationToken)
    {
        if (!Equals(principal, _principal))
        {
            throw new BridgeUpdateRejectedException(
                "artifact_principal_mismatch",
                "Artifact fetch escaped its authenticated update session.");
        }

        if (artifactUri == _manifestUri)
        {
            throw new BridgeUpdateRejectedException(
                "artifact_endpoint_conflict",
                "Artifact URL cannot equal the manifest endpoint.");
        }

        // Signed object-store URLs carry their own bounded authorization. The
        // device bearer token is deliberately not forwarded to another host.
        return await _http.GetStreamAsync(artifactUri, cancellationToken)
            .ConfigureAwait(false);
    }
}

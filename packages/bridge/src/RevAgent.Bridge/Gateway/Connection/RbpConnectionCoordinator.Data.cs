using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private async Task ReceiveLoopAsync(ConnectionCycleContext context)
    {
        try
        {
            while (!context.Token.IsCancellationRequested)
            {
                RbpEnvelope envelope =
                    await context.Cycle.ReceiveAsync(context.Token)
                        .ConfigureAwait(false);
                switch (envelope.Scope)
                {
                    case RbpEnvelopeScope.Control:
                        CurrentOperationResult<bool> control =
                            await TryRunCurrentOperationAsync(
                                    context,
                                    () => HandleControlEnvelopeAsync(
                                        context, envelope))
                                .ConfigureAwait(false);
                        if (!control.Started) return;
                        break;
                    case RbpEnvelopeScope.Data:
                        CurrentOperationResult<bool> data =
                            await TryRunCurrentOperationAsync(
                                    context,
                                    () => HandleDataEnvelopeAsync(
                                        context, envelope))
                                .ConfigureAwait(false);
                        if (!data.Started) return;
                        break;
                    default:
                        throw new RbpCoordinatorException(
                            RbpCoordinatorErrorCode.UnexpectedControl,
                            "A negotiated connection returned a " +
                            "pre-negotiation envelope.");
                }
            }
        }
        catch (OperationCanceledException)
            when (context.Token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            context.FailPending(exception);
            context.Cancel();
            throw;
        }
    }

    private async Task HandleControlEnvelopeAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        switch (envelope.Type)
        {
            case "session_registered":
                await context.DeliverRegistrationAsync(envelope)
                    .ConfigureAwait(false);
                return;
            case "resume_ack":
                await context.DeliverResumeAsync(
                        RequiredString(
                            envelope.Payload,
                            "rsid",
                            maximumLength: 256),
                        envelope)
                    .ConfigureAwait(false);
                return;
            case "heartbeat_ack":
                await ApplyHeartbeatAcknowledgementAsync(context, envelope)
                    .ConfigureAwait(false);
                return;
            case "goodbye":
                throw ParseGoodbye(
                    envelope,
                    context.ContinuousSteadyMilliseconds);
            default:
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    $"Unexpected RBP control message '{envelope.Type}'.");
        }
    }

    private async Task HandleDataEnvelopeAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        if (envelope.Rsid is not { } rsid ||
            envelope.Sequence is not { } sequence)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "Inbound RBP data targets a session that is not bound to " +
                "the current connection.");
        }

        var snapshot = new RbpDataEnvelopeSnapshot(
            envelope.Type,
            envelope.Id,
            rsid,
            sequence,
            envelope.Payload,
            envelope.Acknowledgement,
            envelope.Timestamp,
            envelope.Version ?? 1);
        bool invocation = string.Equals(
            snapshot.Type, "invoke", StringComparison.Ordinal);
        bool batch = string.Equals(
            snapshot.Type, "invoke_batch", StringComparison.Ordinal);
        RbpInvocationAuthoritySnapshot? inboundAuthority = null;
        if (!context.IsDispatchAllowed(rsid))
        {
            long observedAt = _clock.MonotonicMilliseconds;
            if (!context.HasCleanupReceivePermit(rsid, observedAt))
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Inbound RBP data targets a session that is not bound to " +
                    "the current connection.");
            }

            if (envelope.Disposition != RbpEnvelopeDisposition.Known)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SequenceFault,
                    "The cleanup-only receive window covers only known RBP " +
                    "data messages.");
            }

            string correlationId = ValidateCleanupDiscardShape(snapshot);
            string immutableDigest =
                Rfc8785Json.ImmutableEnvelopeDigest(snapshot);
            CleanupReceiveDisposition disposition =
                context.TryDiscardCleanupData(
                    snapshot,
                    immutableDigest,
                    correlationId,
                    observedAt);
            if (disposition == CleanupReceiveDisposition.Discarded)
            {
                return;
            }

            if (disposition == CleanupReceiveDisposition.Conflict)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SequenceFault,
                    "Inbound RBP data conflicts with the bounded cleanup-only " +
                    "receive window.");
            }

            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "Inbound RBP data targets a session that is not bound to " +
                "the current connection.");
        }

        ConnectionCycleContext.PreparedCurrentOperation<RbpInboundDataResult>
            accept = context.PrepareCurrentOperation(() =>
                _journal.AcceptInboundDataAsync(snapshot, context.Token));
        bool acceptPublished = false;
        bool acceptReserved = false;
        bool acceptCurrent = TryCommitCurrent(context, () =>
        {
            if (invocation || batch)
            {
                inboundAuthority =
                    context.TryCreateInvocationAuthority(snapshot.Rsid);
                if (inboundAuthority is null) return;
            }
            acceptPublished = context.CommitPreparedCurrentOperation(accept);
            if (acceptPublished) acceptReserved = accept.TryReserveStart();
        });
        if (!acceptCurrent || !acceptPublished || !acceptReserved)
        {
            accept.Abort();
            if (context.Token.IsCancellationRequested) return;
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "Inbound invocation has no exact current session authority.");
        }
        if (!accept.Launch()) throw NonDrainingConnectionAuthority();
        RbpInboundDataResult accepted = await accept.Task.ConfigureAwait(false);
        if (accepted.Kind is RbpInboundDataKind.Gap or
            RbpInboundDataKind.ProtocolFault)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SequenceFault,
                "Inbound RBP sequence authority rejected the data envelope.");
        }

        if (accepted.Kind != RbpInboundDataKind.Accepted)
        {
            // A duplicate the sequence authority already answered. Re-running
            // the invocation would be a second delivery of the same frame, and
            // Section 12.2 arbitrates redelivery on the invocation key, not on
            // the transport sequence.
            if (accepted.Kind == RbpInboundDataKind.Duplicate &&
                string.Equals(snapshot.Type, "invoke", StringComparison.Ordinal) &&
                _omittedOriginObservation.IsArmedExactReplay(
                    snapshot.Rsid, snapshot.Payload))
            {
                // Exact fixture-only duplicate after the deliberate post-commit
                // close. The dispatcher still performs normal journal replay;
                // this is never a second add-in dispatch.
                ConnectionCycleContext.PreparedInvocationWork? duplicate =
                    PrepareInvocationForLaunch(
                        context, snapshot, inboundAuthority!, batch: false);
                if (duplicate is not null && !duplicate.Launch())
                    throw NonDrainingConnectionAuthority();
            }
            return;
        }

        if (invocation || batch)
        {
            ConnectionCycleContext.PreparedInvocationWork? prepared =
                PrepareInvocationForLaunch(
                    context, snapshot, inboundAuthority!, batch);
            if (prepared is null)
            {
                if (context.Token.IsCancellationRequested) return;
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The accepted invocation lost same-attempt session " +
                    "authority before journal handoff ownership.");
            }
            if (!prepared.Launch()) throw NonDrainingConnectionAuthority();
            return;
        }

        _ = await TryRunCurrentOperationAsync(
                context,
                () => JournalAcceptedInboundAsync(snapshot, context.Token))
            .ConfigureAwait(false);
    }

    private ConnectionCycleContext.PreparedInvocationWork?
        PrepareInvocationForLaunch(
        ConnectionCycleContext context,
        RbpDataEnvelopeSnapshot envelope,
        RbpInvocationAuthoritySnapshot authority,
        bool batch)
    {
        ConnectionCycleContext.PreparedInvocationWork prepared =
            context.CreatePreparedInvocation(envelope, authority, batch);
        bool published = false;
        bool current = TryCommitCurrent(context, () =>
            published = context.CommitPreparedInvocation(prepared));
        if (!current || !published)
        {
            prepared.Abort();
            return null;
        }

        bool reserved = false;
        if (!TryCommitCurrent(context, () => reserved =
                context.TryReservePreparedInvocationStart(prepared)) ||
            !reserved)
        {
            prepared.Abort();
            return null;
        }
        return prepared;
    }

    private static string ValidateCleanupDiscardShape(
        RbpDataEnvelopeSnapshot envelope)
    {
        switch (envelope.Type)
        {
            case "invoke":
                {
                    RbpInvokeRequest request =
                        RbpInvokeRequest.Parse(envelope.Rsid, envelope.Payload);
                    _ = Rfc8785Json.MakeParametersDigest(request.Parameters);
                    _ = request.ParseClearances();
                    return request.InvocationId;
                }
            case "invoke_batch":
                {
                    RbpBatchRequest request =
                        RbpBatchRequest.Parse(envelope.Rsid, envelope.Payload);
                    foreach (RbpBatchStepRequest step in request.Steps)
                    {
                        string expected =
                            Rfc8785Json.MakeParametersDigest(step.Parameters);
                        if (!string.Equals(
                                step.ParametersDigest,
                                expected,
                                StringComparison.Ordinal))
                        {
                            throw new RbpCoordinatorException(
                                RbpCoordinatorErrorCode.SequenceFault,
                                "A cleanup-only invoke_batch step parameters " +
                                "digest is invalid.");
                        }
                    }

                    string expectedBatch = Rfc8785Json.MakeBatchDigest(
                        RbpBatchDigestInput.Parse(envelope.Payload));
                    if (!string.Equals(
                            request.BatchDigest,
                            expectedBatch,
                            StringComparison.Ordinal))
                    {
                        throw new RbpCoordinatorException(
                            RbpCoordinatorErrorCode.SequenceFault,
                            "The cleanup-only invoke_batch digest is invalid.");
                    }

                    _ = request.ParseClearances();
                    return request.BatchId;
                }
            case "cancel":
                if (envelope.Payload.ValueKind == JsonValueKind.Object &&
                    envelope.Payload.TryGetProperty(
                        "invocation_id",
                        out JsonElement target) &&
                    target.ValueKind == JsonValueKind.String &&
                    target.GetString() is { Length: > 0 } correlationId)
                {
                    return correlationId;
                }

                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SequenceFault,
                    "The cleanup-only cancel correlation is invalid.");
            default:
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SequenceFault,
                    "The cleanup-only receive window does not cover this RBP " +
                    "data type.");
        }
    }

    private async Task FlushPendingRetransmitAsync(
        ConnectionCycleContext context)
    {
        CurrentOperationResult<bool> gate =
            await TryRunCurrentOperationAsync(
                    context,
                    async () => await context.OutboundGate
                        .WaitAsync(context.Token).ConfigureAwait(false))
                .ConfigureAwait(false);
        if (!gate.Started) return;
        try
        {
            foreach (RbpDataEnvelopeSnapshot retransmit in
                     context.GetPendingRetransmit())
            {
                await SendCurrentPreparedAsync(
                        context,
                        CreateDataEnvelope(retransmit),
                        retransmit.Rsid)
                    .ConfigureAwait(false);
            }

            _ = TryCommitCurrent(context, context.ClearPendingRetransmit);
        }
        finally
        {
            context.OutboundGate.Release();
        }
    }

    private async Task HeartbeatLoopAsync(ConnectionCycleContext context)
    {
        long priorTick = _clock.MonotonicMilliseconds;
        while (!context.Token.IsCancellationRequested)
        {
            await _clock.DelayAsync(
                    TimeSpan.FromMilliseconds(
                        context.Cycle.Acknowledgement
                            .HeartbeatIntervalMilliseconds),
                    context.Token)
                .ConfigureAwait(false);
            long currentTick = _clock.MonotonicMilliseconds;
            long gap = currentTick - priorTick;
            if (gap < 0 ||
                gap >= _options.EffectiveWakeGapThreshold.TotalMilliseconds)
            {
                throw new RbpWakeGapException(
                    Math.Max(0, priorTick - context.SteadyStartedMilliseconds));
            }

            priorTick = currentTick;
            CurrentOperationResult<bool> reconciled =
                await TryRunCurrentOperationAsync(
                        context,
                        () => ReconcileCurrentCatalogAsync(context))
                    .ConfigureAwait(false);
            if (!reconciled.Started) return;
            CurrentOperationResult<bool> heartbeat =
                await TryRunCurrentOperationAsync(
                        context,
                        () => SendHeartbeatAsync(context))
                    .ConfigureAwait(false);
            if (!heartbeat.Started) return;
        }
    }

    private async Task SendHeartbeatAsync(ConnectionCycleContext context)
    {
        IReadOnlyList<BoundSession> sessions = context.GetBoundSessions();
        IReadOnlyList<string> activeRsids = sessions
            .Where(item => item.Lifecycle.DispatchAllowed)
            .Select(item => item.Stored.Rsid)
            .Order(StringComparer.Ordinal)
            .ToArray();
        CurrentOperationResult<IReadOnlyList<RbpSessionAcknowledgement>> loaded =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.LoadJournaledAcknowledgementsAsync(
                        activeRsids, context.Token))
                .ConfigureAwait(false);
        if (!loaded.Started) return;
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements = loaded.Value;
        IReadOnlyList<RevAgent.Bridge.Bootstrap.Updates.BridgeUpdateReport>
            updateReports = [];
        if (_updateReports is not null)
        {
            CurrentOperationResult<IReadOnlyList<
                RevAgent.Bridge.Bootstrap.Updates.BridgeUpdateReport>> reports =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _updateReports.ReadPendingAsync(context.Token))
                    .ConfigureAwait(false);
            if (!reports.Started) return;
            updateReports = BridgeUpdateHeartbeatReports.Bound(reports.Value);
        }
        IReadOnlyList<string> tombstones =
            context.GetSentUnregisterRsids();
        var fence = new RbpHeartbeatFence(
            context.Generation,
            activeRsids,
            acknowledgements,
            tombstones);
        JsonElement payload = CreateHeartbeatPayload(
            sessions,
            acknowledgements,
            updateReports);
        using var deadlineCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(context.Token);
        try
        {
            Task deadline = _clock.DelayAsync(
                _options.EffectiveHeartbeatAcknowledgementTimeout,
                deadlineCancellation.Token);
            HeartbeatFlight? flight = null;
            if (!TryCommitCurrent(context, () =>
                    flight = context.InstallHeartbeatFlight(
                        fence,
                        deadline,
                        updateReports.Select(report => report.ReportId).ToArray())) ||
                flight is null)
                return;

            Task send;
            Exception? sendFailure = null;
            bool sendCompleted = false;
            try
            {
                CurrentOperationResult<Task> started =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => Task.FromResult(context.Cycle.SendAsync(
                                CreateControlEnvelope("heartbeat", payload),
                                context.Token)))
                        .ConfigureAwait(false);
                if (!started.Started)
                {
                    _ = context.TryRollbackHeartbeatFlight(flight);
                    return;
                }
                send = started.Value;
            }
            catch (Exception exception)
            {
                if (context.TryRollbackHeartbeatFlight(flight))
                {
                    throw;
                }

                send = Task.CompletedTask;
                sendCompleted = true;
                sendFailure = exception;
            }

            bool acknowledgementObserved = false;
            bool applicationCompleted = false;
            using var applicationCancellation =
                CancellationTokenSource.CreateLinkedTokenSource(context.Token);
            Task? applicationDeadline = null;
            try
            {
                while (!sendCompleted ||
                       !acknowledgementObserved ||
                       !applicationCompleted)
                {
                    var pending = new List<Task>(4);
                    if (!sendCompleted)
                    {
                        pending.Add(send);
                    }

                    if (!acknowledgementObserved)
                    {
                        pending.Add(flight.Observed.Task);
                        pending.Add(flight.Deadline);
                    }
                    else
                    {
                        if (!applicationCompleted)
                        {
                            pending.Add(flight.Applied.Task);
                        }

                        pending.Add(applicationDeadline ??
                            throw new InvalidOperationException(
                                "An observed heartbeat must own an application " +
                                "deadline."));
                    }

                    Task completed = await Task.WhenAny(pending)
                        .WaitAsync(context.Token)
                        .ConfigureAwait(false);
                    if (ReferenceEquals(completed, flight.Deadline))
                    {
                        if (context.TryRollbackHeartbeatFlight(flight))
                        {
                            ObserveLateFault(send);
                            context.Token.ThrowIfCancellationRequested();
                            throw new RbpCoordinatorException(
                                RbpCoordinatorErrorCode.HeartbeatTimeout,
                                "The Gateway did not acknowledge the heartbeat " +
                                "within 10 seconds.");
                        }

                        await flight.Observed.Task.ConfigureAwait(false);
                        acknowledgementObserved = true;
                        deadlineCancellation.Cancel();
                        applicationDeadline ??= _clock.DelayAsync(
                            _options.EffectiveHeartbeatCompletionTimeout,
                            applicationCancellation.Token);
                    }

                    if (ReferenceEquals(completed, send))
                    {
                        try
                        {
                            await send.ConfigureAwait(false);
                            sendCompleted = true;
                        }
                        catch (Exception exception)
                        {
                            sendCompleted = true;
                            if (context.TryRollbackHeartbeatFlight(flight))
                            {
                                throw;
                            }

                            sendFailure = exception;
                        }
                    }

                    if (ReferenceEquals(completed, flight.Observed.Task))
                    {
                        await flight.Observed.Task.ConfigureAwait(false);
                        acknowledgementObserved = true;
                        deadlineCancellation.Cancel();
                        applicationDeadline ??= _clock.DelayAsync(
                            _options.EffectiveHeartbeatCompletionTimeout,
                            applicationCancellation.Token);
                    }

                    if (ReferenceEquals(completed, flight.Applied.Task))
                    {
                        await flight.Applied.Task.ConfigureAwait(false);
                        applicationCompleted = true;
                    }

                    if (ReferenceEquals(completed, applicationDeadline))
                    {
                        ObserveLateFault(send);
                        context.Token.ThrowIfCancellationRequested();
                        throw new RbpCoordinatorException(
                            RbpCoordinatorErrorCode.HeartbeatApplicationTimeout,
                            "The observed heartbeat acknowledgement did not " +
                            "finish transport send and durable application " +
                            "before the connection liveness window elapsed.");
                    }
                }
            }
            catch (OperationCanceledException)
                when (context.Token.IsCancellationRequested)
            {
                _ = context.TryRollbackHeartbeatFlight(flight);
                ObserveLateFault(send);
                throw;
            }
            catch
            {
                ObserveLateFault(send);
                throw;
            }
            finally
            {
                applicationCancellation.Cancel();
            }

            if (sendFailure is not null)
            {
                ExceptionDispatchInfo.Capture(sendFailure).Throw();
                throw new InvalidOperationException(
                    "ExceptionDispatchInfo.Throw unexpectedly returned.");
            }
        }
        finally
        {
            deadlineCancellation.Cancel();
        }
    }

    private async Task ApplyHeartbeatAcknowledgementAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        HeartbeatFlight? flight = null;
        if (!TryCommitCurrent(context, () =>
                flight = context.ConsumeAndObserveHeartbeatFlight()))
            return;
        if (flight is null)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.UnexpectedControl,
                "An unsolicited heartbeat_ack cannot finalize connection " +
                "state.");
        }

        try
        {
            IReadOnlyList<RbpSessionAcknowledgement> acknowledgements =
                ParseHeartbeatAcknowledgements(envelope);
            IReadOnlyList<string> updateReportAcknowledgements =
                ParseUpdateReportAcknowledgements(envelope);
            acknowledgements = GateRecoveryCarrierAcknowledgements(
                context, acknowledgements);
            await ApplyRecoveryCarrierAcknowledgementsAsync(
                    context,
                    acknowledgements)
                .ConfigureAwait(false);
            await ApplyRecoveryTerminalAcknowledgementsAsync(
                    context,
                    acknowledgements)
                .ConfigureAwait(false);
            RbpHeartbeatFence fence = flight.Fence with
            {
                Acknowledgements = acknowledgements,
            };
            CurrentOperationResult<RbpHeartbeatFenceResult> fenceApplied =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.ApplyHeartbeatFenceAcknowledgementAsync(
                            fence, context.Token))
                    .ConfigureAwait(false);
            if (!fenceApplied.Started) return;
            RbpHeartbeatFenceResult applied = fenceApplied.Value;
            CurrentOperationResult<bool> observations =
                await TryRunCurrentOperationAsync(
                        context,
                        () =>
                        {
                            foreach (RbpSessionAcknowledgement acknowledgement in
                                     acknowledgements)
                            {
                                _ = _omittedOriginObservation
                                    .TryConsumeDurableAcknowledgement(
                                        acknowledgement.Rsid,
                                        acknowledgement.Sequence);
                            }
                            ObserveDocumentContextAcknowledgements(
                                acknowledgements);
                            return Task.FromResult(true);
                        })
                    .ConfigureAwait(false);
            if (!observations.Started) return;
            CurrentOperationResult<IReadOnlyList<RbpReleasedCarrier>> releases =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.ApplyCarrierPlanAcknowledgementsAsync(
                            acknowledgements, context.Token))
                    .ConfigureAwait(false);
            if (!releases.Started) return;
            IReadOnlyList<RbpReleasedCarrier> releasedCarriers = releases.Value;
            if (releasedCarriers.Count > 0)
            {
                // The journal release is the authority. The producer owns the
                // spool and independently rechecks its terminal fence before
                // deleting any bytes; it is never called on send.
                CurrentOperationResult<bool> spoolReleased =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => CompleteCarrierSpoolReleasesAsync(
                                releasedCarriers, context.Token))
                        .ConfigureAwait(false);
                if (!spoolReleased.Started) return;
            }
            foreach (string rsid in applied.ConfirmedUnregisterRsids)
            {
                CurrentOperationResult<RbpStoredSession?> cleanupRead =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => _journal.GetStoredSessionAsync(
                                rsid, context.Token))
                        .ConfigureAwait(false);
                if (!cleanupRead.Started) return;
                RbpStoredSession? cleanupSession = cleanupRead.Value;
                if (!TryCommitCurrent(context, () =>
                        context.MarkUnregisterConfirmed(rsid)))
                    return;
                CurrentOperationResult<bool> cleanupCompleted =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => _journal.CompleteConfirmedUnregisterAsync(
                                rsid, context.Token))
                        .ConfigureAwait(false);
                if (!cleanupCompleted.Started) return;
                if (cleanupCompleted.Value && cleanupSession is not null)
                {
                    if (!TryCommitCurrent(context, () =>
                            MarkRegistrationCleanupCompleted(
                                cleanupSession.LocalSessionKey)))
                        return;
                }
            }

            CurrentOperationResult<bool> carriers =
                await TryRunCurrentOperationAsync(
                        context,
                        () => ScheduleActiveRecoveryCarriersAsync(context))
                    .ConfigureAwait(false);
            if (!carriers.Started) return;
            CurrentOperationResult<bool> terminals =
                await TryRunCurrentOperationAsync(
                        context,
                        () => ScheduleActiveRecoveryTerminalsAsync(context))
                    .ConfigureAwait(false);
            if (!terminals.Started) return;

            if (updateReportAcknowledgements.Count > 0)
            {
                if (_updateReports is null)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.UnexpectedControl,
                        "heartbeat_ack returned update reports when reporting is disabled.");
                }

                try
                {
                    BridgeUpdateHeartbeatReports.Acknowledge(
                        _updateReports,
                        flight.UpdateReportIds,
                        updateReportAcknowledgements);
                }
                catch (InvalidDataException exception)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.UnexpectedControl,
                        exception.Message,
                        exception);
                }
            }

            _ = TryCommitCurrent(context, () =>
                context.CompleteHeartbeatFlight(flight));
        }
        catch (Exception exception)
        {
            context.FailHeartbeatFlight(flight, exception);
            throw;
        }
    }

    private async Task CompleteCarrierSpoolReleasesAsync(
        IReadOnlyList<RbpReleasedCarrier> releases,
        CancellationToken cancellationToken)
    {
        if (releases.Count == 0 || _carrierProducer is null)
        {
            return;
        }

        // Cleanup first, confirmation second: a crash in between retains a
        // pending token that startup/reconnect reissues. The spool operation
        // itself is absent-safe only after a successful prior release.
        _carrierProducer.SweepExpired(releases);
        foreach (RbpReleasedCarrier release in releases)
        {
            await _journal.ConfirmSpoolReleasedAsync(release, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task RecoverPendingInboundHandoffsAsync(
        IReadOnlyList<RbpPendingInboundHandoff> pending,
        CancellationToken cancellationToken)
    {
        foreach (RbpPendingInboundHandoff handoff in pending
                     .OrderBy(item => item.Rsid, StringComparer.Ordinal)
                     .ThenBy(item => item.Envelope.Sequence))
        {
            await JournalAcceptedInboundAsync(
                    handoff.Envelope,
                    cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task JournalAcceptedInboundAsync(
        RbpDataEnvelopeSnapshot envelope,
        CancellationToken cancellationToken)
    {
        string immutableDigest =
            Rfc8785Json.ImmutableEnvelopeDigest(envelope);
        long now = _clock.UtcNow.ToUnixTimeMilliseconds();
        await _journal.ExecuteImmediateAsync(
                context =>
                {
                    RbpInboundJournalReceipt receipt =
                        _inboundJournal.Journal(context, envelope);
                    context.MarkInboundJournaled(
                        envelope.Rsid,
                        envelope.Sequence,
                        envelope.Id,
                        immutableDigest,
                        receipt.CorrelationId,
                        receipt.JournalRecordDigest,
                        now);
                    return true;
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task CompleteConfirmedCleanupAsync(
        IReadOnlyList<RbpUnregisterTombstone> confirmed,
        CancellationToken cancellationToken)
    {
        foreach (RbpUnregisterTombstone tombstone in confirmed.OrderBy(
                     item => item.Rsid,
                     StringComparer.Ordinal))
        {
            _ = await _journal.CompleteConfirmedUnregisterAsync(
                    tombstone.Rsid,
                    cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task<bool> TryRecordShutdownUnregistersAsync(
        ConnectionCycleContext context,
        ConnectionTeardownDeadline teardownDeadline)
    {
        foreach (BoundSession session in context.GetBoundSessions())
        {
            if (teardownDeadline.Remaining == TimeSpan.Zero)
                return false;
            try
            {
                RbpUnregisterTombstone tombstone =
                    await _journal.RecordUnregisterIntentAsync(
                            session.Stored.Rsid,
                            RbpSessionUnregisterReason.BridgeShutdown,
                            teardownDeadline.Token)
                        .ConfigureAwait(false);
                context.RevokeBoundSession(
                    session.Stored.Rsid,
                    RbpSessionUnregisterReason.BridgeShutdown);
            }
            catch (Exception exception)
                when (exception is OperationCanceledException or
                      RbpJournalException)
            {
                return false;
            }
        }
        return true;
    }

}

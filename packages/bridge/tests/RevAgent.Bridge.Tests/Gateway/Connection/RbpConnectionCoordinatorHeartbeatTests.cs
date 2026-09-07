using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Updates;
using System.Text.Json;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task UpdateReportsRemainUntilMatchingHeartbeatAck()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var layout = new BridgeInstallLayout(
            Path.Combine(directory.Path, "install", "Bridge"),
            Path.Combine(directory.Path, "state"));
        var reports = new BridgeUpdateReportStore(layout);
        BridgeUpdateReport pending = await reports.AppendAsync(
            "10000000-0000-4000-8000-000000000003",
            "1.0.0",
            "2.0.0",
            2,
            "sha256:" + new string('a', 64),
            BridgeUpdateReportStates.Staged,
            "components_verified_and_staged",
            null,
            clock.UtcNow,
            CancellationToken.None);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock,
            updateReports: reports);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().HasActiveConnection);
        Assert.Single(await reports.ReadPendingAsync(CancellationToken.None));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(async () =>
            (await reports.ReadPendingAsync(CancellationToken.None)).Count == 0);

        RbpEnvelope heartbeat = Assert.Single(
            cycle.Sent,
            item => item.Type == "heartbeat");
        JsonElement row = Assert.Single(
            heartbeat.Payload.GetProperty("update_reports").EnumerateArray());
        Assert.Equal(pending.ReportId, row.GetProperty("report_id").GetString());

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task HeartbeatDeadlineStartsBeforeBlockedTransportSend()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var sendEntered = NewSignal();
        var first = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: async (cycle, envelope, cancellationToken) =>
            {
                if (envelope.Type == "heartbeat")
                {
                    sendEntered.TrySetResult();
                    await Task.Delay(
                        Timeout.InfiniteTimeSpan,
                        cancellationToken);
                    return;
                }

                DeliverResponse(cycle, responder, envelope);
            });
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        clock.Advance(TimeSpan.FromSeconds(15));
        await sendEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.True(clock.HasDelayDueIn(TimeSpan.FromSeconds(10)));
        clock.Advance(TimeSpan.FromSeconds(10));
        await EventuallyAsync(() => factory.OpenCount == 2);
        Assert.True(first.CloseCount > 0);
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ReentrantAckConsumesFlightBeforeSendReturns()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var ackQueued = NewSignal();
        var releaseSend = NewSignal();
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: async (current, envelope, cancellationToken) =>
            {
                DeliverResponse(current, responder, envelope);
                if (envelope.Type == "heartbeat")
                {
                    ackQueued.TrySetResult();
                    await releaseSend.Task.WaitAsync(cancellationToken);
                }
            });
        var catalog = new MutableSessionCatalog(LocalSession(8080, 1000));
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            catalog,
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        catalog.Replace();
        clock.Advance(TimeSpan.FromSeconds(15));
        await ackQueued.Task.WaitAsync(TimeSpan.FromSeconds(2));

        await EventuallyAsync(
            async () => await store.GetStoredSessionAsync("rs-8080") is null);
        Assert.Equal(
            1,
            cycle.Sent.Count(item => item.Type == "heartbeat"));
        clock.Advance(TimeSpan.FromSeconds(25));
        Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);
        Assert.Equal(
            1,
            cycle.Sent.Count(item => item.Type == "heartbeat"));

        releaseSend.TrySetResult();
        await EventuallyAsync(
            () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ObservedAckCancelsDeadlineWhileDurableApplyIsBlocked()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(cycle);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        clock.Advance(TimeSpan.FromSeconds(15));
        await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(
            1,
            cycle.Sent.Count(item => item.Type == "heartbeat"));
        clock.Advance(TimeSpan.FromSeconds(10));
        Assert.Equal(1, faults.HitCount);
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(0, cycle.CloseCount);
        Assert.Equal(
            1,
            cycle.Sent.Count(item => item.Type == "heartbeat"));
        clock.Advance(TimeSpan.FromSeconds(15));
        Assert.Equal(1, factory.OpenCount);

        faults.Release();
        await EventuallyAsync(
            () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task UnsolicitedDuplicateAndStaleBindingCannotConfirmTombstone()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = LocalSession(8080, 1000);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(
            responder.Respond,
            leaveInboundOpenAfterClose: true);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var catalog = new MutableSessionCatalog(local);
        var coordinator = Coordinator(
            factory,
            store,
            catalog,
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => first.Sent.Count(item => item.Type == "heartbeat") == 1);
        await EventuallyAsync(
            () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));
        RbpEnvelope heartbeat = Assert.Single(
            first.Sent,
            item => item.Type == "heartbeat");
        RbpEnvelope duplicate = Assert.IsType<RbpEnvelope>(
            responder.Respond(heartbeat));

        catalog.Replace();
        _ = await store.RecordUnregisterIntentAsync(
            "rs-8080",
            RbpSessionUnregisterReason.RevitExited);
        first.Deliver(duplicate);
        await EventuallyAsync(() => factory.OpenCount == 2);
        await EventuallyAsync(
            () => second.Sent.Any(
                item => item.Type == "session_unregister"));
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            (await store.GetUnregisterTombstoneAsync("rs-8080"))!.Phase);

        first.Deliver(duplicate);
        await Task.Delay(25);
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            (await store.GetUnregisterTombstoneAsync("rs-8080"))!.Phase);
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            async () => await store.GetStoredSessionAsync("rs-8080") is null);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task FailedHeartbeatSendRollsBackBeforeNewGeneration()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: (cycle, envelope, _) =>
            {
                if (envelope.Type == "heartbeat")
                {
                    throw new IOException("heartbeat send failed");
                }

                DeliverResponse(cycle, responder, envelope);
                return Task.CompletedTask;
            });
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var catalog = new MutableSessionCatalog(LocalSession(8080, 1000));
        var coordinator = Coordinator(factory, store, catalog, clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        catalog.Replace();
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => factory.OpenCount == 2);
        await EventuallyAsync(
            () => second.Sent.Any(
                item => item.Type == "session_unregister"));
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            (await store.GetUnregisterTombstoneAsync("rs-8080"))!.Phase);
        Assert.False(
            clock.HasOutstandingDelayDueIn(TimeSpan.FromSeconds(10)));

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            async () => await store.GetStoredSessionAsync("rs-8080") is null);
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task TimedOutSendCannotBlockReplacementAndLateFaultIsObserved()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var lateSend = NewSignal();
        var first = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: (_, envelope, _) =>
                envelope.Type == "heartbeat"
                    ? lateSend.Task
                    : Task.CompletedTask);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => first.Sent.Count(item => item.Type == "heartbeat") == 1);
        clock.Advance(TimeSpan.FromSeconds(10));
        await EventuallyAsync(() => factory.OpenCount == 2);

        lateSend.TrySetException(new IOException("late transport fault"));
        await Task.Delay(25);
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);
        Assert.True(first.CloseCount > 0);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ReentrantAckCannotLeaveSendPendingPastLivenessWindow()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var stalledSend = NewSignal();
        var first = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: (cycle, envelope, _) =>
            {
                DeliverResponse(cycle, responder, envelope);
                return envelope.Type == "heartbeat"
                    ? stalledSend.Task
                    : Task.CompletedTask;
            });
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(200));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);

        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().HasActiveConnection);
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                () => first.Sent.Count(
                    item => item.Type == "heartbeat") == 1);
            await EventuallyAsync(
                () => clock.HasDelayDueIn(TimeSpan.FromSeconds(65)));

            clock.Advance(TimeSpan.FromSeconds(65));
            await EventuallyAsync(() => factory.OpenCount == 2);
            Assert.True(first.CloseCount > 0);
            Assert.Equal(
                2,
                coordinator.GetSnapshot().ConnectionGeneration);
        }
        finally
        {
            stalledSend.TrySetException(
                new IOException("late re-entrant send fault"));
            stop.Cancel();
            await run.WaitAsync(TimeSpan.FromSeconds(2));
        }
    }

    [Fact]
    public async Task ConsumedAckAppliesOnceBeforeLateSendFailureReconnects()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var finishSend = NewSignal();
        var first = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: async (cycle, envelope, _) =>
            {
                DeliverResponse(cycle, responder, envelope);
                if (envelope.Type == "heartbeat")
                {
                    await finishSend.Task;
                }
            });
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        clock.Advance(TimeSpan.FromSeconds(15));
        await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));

        finishSend.TrySetException(
            new IOException("send failed after heartbeat_ack"));
        await Task.Delay(25);
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(0, first.CloseCount);
        Assert.Equal(1, faults.HitCount);

        faults.Release();
        await EventuallyAsync(() => factory.OpenCount == 2);
        Assert.True(first.CloseCount > 0);
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ServiceStopIsBoundedWhileAckApplicationIsBlocked()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(cycle);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(20));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);

        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().HasActiveConnection);
            faults.Arm(RbpJournalFaultPoint.BeforeCommit);
            clock.Advance(TimeSpan.FromSeconds(15));
            await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            await EventuallyAsync(
                () => clock.HasDelayDueIn(TimeSpan.FromSeconds(65)));

            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            stop.Cancel();
            RbpCoordinatorException failure = await Assert.ThrowsAsync<
                RbpCoordinatorException>(() =>
                run.WaitAsync(TimeSpan.FromSeconds(1)));
            Assert.Equal(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                failure.ErrorCode);
            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
            Assert.False(coordinator.GetSnapshot().HasActiveConnection);
            Assert.Equal(
                RbpConnectionPhase.Shutdown,
                coordinator.GetSnapshot().Lifecycle.Phase);
            Assert.Equal(1, factory.OpenCount);
            Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);
            Assert.False(
                clock.HasOutstandingDelayDueIn(TimeSpan.FromSeconds(65)));

            RbpCoordinatorException restart =
                await Assert.ThrowsAsync<RbpCoordinatorException>(
                    () => coordinator.RunAsync());
            Assert.Equal(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                restart.ErrorCode);
            Assert.Equal(1, factory.OpenCount);
            Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);
        }
        finally
        {
            stop.Cancel();
            faults.Release();
            try
            {
                await run.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (RbpCoordinatorException exception)
                when (exception.ErrorCode ==
                    RbpCoordinatorErrorCode.NonDrainingConnectionAuthority)
            {
            }
        }

        await EventuallyAsync(
            () => coordinator.GetSnapshot().OwnedBackgroundTaskCount == 0);
    }

    [Fact]
    public async Task NonDrainingAckApplicationPoisonsAuthority()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(20));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);

        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().HasActiveConnection);
            faults.Arm(RbpJournalFaultPoint.BeforeCommit);
            clock.Advance(TimeSpan.FromSeconds(15));
            await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            await EventuallyAsync(
                () => clock.HasDelayDueIn(TimeSpan.FromSeconds(65)));

            clock.Advance(TimeSpan.FromSeconds(65));
            RbpCoordinatorException failure =
                await Assert.ThrowsAsync<RbpCoordinatorException>(
                    () => run.WaitAsync(TimeSpan.FromSeconds(2)));
            Assert.Equal(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                failure.ErrorCode);
            // The bounded deadline may expire before the retained close wins
            // the scheduler. It may be skipped or start once, never twice.
            Assert.InRange(first.CloseCount, 0, 1);
            Assert.Equal(0, first.DisposeCount);
            Assert.Equal(1, factory.OpenCount);
            Assert.Empty(second.Sent);
            Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);

            RbpCoordinatorException restart =
                await Assert.ThrowsAsync<RbpCoordinatorException>(
                    () => coordinator.RunAsync());
            Assert.Equal(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                restart.ErrorCode);
            Assert.Equal(1, factory.OpenCount);
        }
        finally
        {
            faults.Release();
            stop.Cancel();
            try
            {
                await run.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (RbpCoordinatorException exception)
                when (exception.ErrorCode ==
                      RbpCoordinatorErrorCode
                          .NonDrainingConnectionAuthority)
            {
            }
        }

        await EventuallyAsync(
            () => coordinator.GetSnapshot().OwnedBackgroundTaskCount == 0);
        Assert.InRange(first.CloseCount, 0, 1);
        Assert.Equal(0, first.DisposeCount);
    }

    [Fact]
    public async Task MalformedAckFailsClosedAndNextGenerationCanHeartbeat()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        RbpEnvelope? MalformedFirstAck(RbpEnvelope envelope)
        {
            RbpEnvelope? response = responder.Respond(envelope);
            return envelope.Type == "heartbeat" && response is not null
                ? response with
                {
                    Payload = Json("""{"acks":[]}"""),
                }
                : response;
        }

        var first = new FakeConnectionCycle(MalformedFirstAck);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () =>
            {
                RbpConnectionCoordinatorSnapshot snapshot =
                    coordinator.GetSnapshot();
                return snapshot.ConnectionGeneration == 1 &&
                       snapshot.HasActiveConnection &&
                       snapshot.OwnedBackgroundTaskCount == 2;
            });
        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => factory.OpenCount == 2);
        Assert.True(first.CloseCount > 0);

        await EventuallyAsync(
            () =>
            {
                RbpConnectionCoordinatorSnapshot snapshot =
                    coordinator.GetSnapshot();
                return snapshot.ConnectionGeneration == 2 &&
                       snapshot.HasActiveConnection &&
                       snapshot.OwnedBackgroundTaskCount == 2;
            });
        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => second.Sent.Count(item => item.Type == "heartbeat") == 1);
        await EventuallyAsync(
            () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task PostCommitFenceRereadCompletesWithoutReconnect()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(cycle);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));

        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(0, cycle.CloseCount);
        Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);
        Assert.False(
            clock.HasOutstandingDelayDueIn(TimeSpan.FromSeconds(10)));
        Assert.False(
            clock.HasOutstandingDelayDueIn(TimeSpan.FromSeconds(65)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => cycle.Sent.Count(item => item.Type == "heartbeat") == 2);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task JournalApplyFailureCannotReuseFailedHeartbeatBinding()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => factory.OpenCount == 2);

        Assert.Equal(
            1,
            first.Sent.Count(item => item.Type == "heartbeat"));
        Assert.True(first.CloseCount > 0);
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);
        Assert.DoesNotContain(
            second.Sent,
            item => item.Type == "heartbeat");
        Assert.False(
            clock.HasOutstandingDelayDueIn(TimeSpan.FromSeconds(65)));

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private static void DeliverResponse(
        FakeConnectionCycle cycle,
        ScriptedGatewayResponder responder,
        RbpEnvelope envelope)
    {
        if (responder.Respond(envelope) is { } response)
        {
            cycle.Deliver(response);
        }
    }

    private static TaskCompletionSource NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}

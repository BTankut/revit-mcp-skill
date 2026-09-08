using System.IO.Compression;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Updates;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Update;
using RevAgent.Contracts.Signing;

namespace RevAgent.Bridge.Tests.Update;

public sealed class BridgeUpdateEngineTests
{
    [Fact]
    public void DeployAddinSlotWholeDirectoryReplacementPreservesCommandResolution()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-eu21-command-payload-{Guid.NewGuid():N}");
        string source = Path.Combine(root, "source");
        string destination = Path.Combine(root, "installed", "revAgentPlugin");
        string sourceCommands = Path.Combine(source, "Commands");
        string sourceCommandSet = Path.Combine(sourceCommands, "revAgentCommandSet");
        string sourceVersion = Path.Combine(sourceCommandSet, "2022");
        Directory.CreateDirectory(sourceVersion);
        Directory.CreateDirectory(destination);
        File.WriteAllText(Path.Combine(destination, "stale.txt"), "old whole-directory payload");
        File.WriteAllText(
            Path.Combine(sourceCommandSet, "command.json"),
            new JObject
            {
                ["name"] = "revAgentCommandSet",
                ["commands"] = new JArray(new JObject
                {
                    ["commandName"] = "fixture_command",
                    ["assemblyPath"] = "revAgentCommandSet.dll",
                }),
            }.ToString());
        File.WriteAllText(
            Path.Combine(sourceCommands, "commandRegistry.json"),
            new JObject
            {
                ["Commands"] = new JArray(new JObject
                {
                    ["commandName"] = "fixture_command",
                    ["assemblyPath"] = @"revAgentCommandSet\\2022\\revAgentCommandSet.dll",
                    ["enabled"] = true,
                    ["supportedRevitVersions"] = new JArray("2022"),
                }),
            }.ToString());
        File.WriteAllText(
            Path.Combine(sourceVersion, "revAgentCommandSet.dll"),
            "generated command-set fixture");

        try
        {
            BridgeUpdateEngine.DeployAddinSlot(source, destination);

            Assert.False(File.Exists(Path.Combine(destination, "stale.txt")));
            string commandsRoot = Path.Combine(destination, "Commands");
            JObject registry = JObject.Parse(
                File.ReadAllText(Path.Combine(commandsRoot, "commandRegistry.json")));
            JObject descriptor = JObject.Parse(
                File.ReadAllText(Path.Combine(commandsRoot, "revAgentCommandSet", "command.json")));
            JToken descriptorCommand = Assert.Single(descriptor["commands"]!);
            JToken registryCommand = Assert.Single(registry["Commands"]!);
            Assert.Equal(
                descriptorCommand.Value<string>("commandName"),
                registryCommand.Value<string>("commandName"));
            string assemblyPath = registryCommand.Value<string>("assemblyPath")!;
            Assert.False(Path.IsPathRooted(assemblyPath));
            string resolvedAssembly = Path.Combine(
                commandsRoot,
                assemblyPath.Replace('\\', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(resolvedAssembly));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public async Task CleanInstallUpdateDeferralApplyAfterCloseAndThreeCrashRollback()
    {
        using var fixture = new UpdateFixture();
        fixture.Revit.IsRunning = true;
        SignedBridgeUpdate update = fixture.Release("2.0.0", sequence: 2);

        BridgeUpdateResult deferred = await fixture.Engine.ApplyAsync(
            update,
            CancellationToken.None);

        Assert.Equal(BridgeUpdateDisposition.DeferredForRevitClose, deferred.Disposition);
        Assert.True(deferred.BridgeApplied);
        Assert.False(deferred.AddinApplied);
        Assert.True(deferred.AddinDeferred);
        Assert.Equal("2.0.0", File.ReadAllText(fixture.Layout.CurrentVersionPointerPath).Trim());
        Assert.Equal("v1-addin", File.ReadAllText(fixture.AddinPayloadPath));
        Assert.Equal(
            "v2-worker",
            File.ReadAllText(WorkerExecutableResolver.Resolve(fixture.Layout).ExecutablePath));

        fixture.Revit.IsRunning = false;
        Assert.True(await fixture.Engine.TryApplyPendingAddinAsync(CancellationToken.None));
        Assert.Equal("v2-addin", File.ReadAllText(fixture.AddinPayloadPath));

        CrashRollbackResult first = await fixture.Rollback.RecordUnexpectedExitAsync(
            CancellationToken.None);
        CrashRollbackResult second = await fixture.Rollback.RecordUnexpectedExitAsync(
            CancellationToken.None);
        CrashRollbackResult third = await fixture.Rollback.RecordUnexpectedExitAsync(
            CancellationToken.None);

        Assert.False(first.RolledBack);
        Assert.False(second.RolledBack);
        Assert.True(third.RolledBack);
        Assert.Equal(3, third.CrashCount);
        Assert.Equal("1.0.0", third.ActiveVersion);
        Assert.Equal("2.0.0", third.QuarantinedVersion);
        Assert.Equal("1.0.0", File.ReadAllText(fixture.Layout.CurrentVersionPointerPath).Trim());
        Assert.Equal(
            "v1-worker",
            File.ReadAllText(WorkerExecutableResolver.Resolve(fixture.Layout).ExecutablePath));
        Assert.Equal("v1-addin", File.ReadAllText(fixture.AddinPayloadPath));

        BridgeUpdateState state = await fixture.State.ReadAsync(CancellationToken.None);
        Assert.Equal(2, state.HighestAcceptedReleaseSequence);
        Assert.Equal("1.0.0", state.ActiveVersion);
        Assert.Contains("2.0.0", state.QuarantinedVersions.Keys);
        IReadOnlyList<BridgeUpdateReport> reports = await fixture.Reports.ReadPendingAsync(
            CancellationToken.None);
        Assert.Contains(reports, report => report.State == BridgeUpdateReportStates.Staged);
        Assert.Contains(reports, report => report.State == BridgeUpdateReportStates.Deferred);
        Assert.Contains(reports, report =>
            report.State == BridgeUpdateReportStates.Applied &&
            report.Reason == "addin_applied_after_revit_close");
        Assert.Contains(reports, report => report.State == BridgeUpdateReportStates.Rollback);
        Assert.Contains(reports, report => report.State == BridgeUpdateReportStates.Quarantined);

        BridgeUpdateRejectedException quarantined = await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
            () => fixture.Engine.ApplyAsync(
                fixture.Release("2.0.0", sequence: 3),
                CancellationToken.None));
        Assert.Equal("version_quarantined", quarantined.Code);
    }

    [Fact]
    public async Task PendingAddinWaitingBehindRollbackCannotApplyQuarantinedVersion()
    {
        using var fixture = new UpdateFixture();
        fixture.Revit.IsRunning = true;
        BridgeUpdateResult deferred = await fixture.Engine.ApplyAsync(
            fixture.Release("2.0.0", sequence: 2),
            CancellationToken.None);
        Assert.Equal(BridgeUpdateDisposition.DeferredForRevitClose, deferred.Disposition);

        Assert.False((await fixture.Rollback.RecordUnexpectedExitAsync(
            CancellationToken.None)).RolledBack);
        Assert.False((await fixture.Rollback.RecordUnexpectedExitAsync(
            CancellationToken.None)).RolledBack);
        fixture.Revit.IsRunning = false;

        var pendingWaiting = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var allowPending = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.State.BeforeMutationAcquireAsync = async (operation, cancellationToken) =>
        {
            if (operation == "pending_addin_apply")
            {
                pendingWaiting.TrySetResult();
                await allowPending.Task.WaitAsync(cancellationToken);
            }
        };

        Task<bool> pendingApply = fixture.Engine.TryApplyPendingAddinAsync(
            CancellationToken.None);
        await pendingWaiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        CrashRollbackResult rollback = await fixture.Rollback.RecordUnexpectedExitAsync(
            CancellationToken.None);
        Assert.True(rollback.RolledBack);
        allowPending.TrySetResult();

        Assert.False(await pendingApply);
        BridgeUpdateState state = await fixture.State.ReadAsync(CancellationToken.None);
        Assert.Equal("1.0.0", state.ActiveVersion);
        Assert.Contains("2.0.0", state.QuarantinedVersions.Keys);
        Assert.Null(state.PendingAddinVersion);
        Assert.Equal("v1-addin", File.ReadAllText(fixture.AddinPayloadPath));
        Assert.Equal(
            "1.0.0",
            File.ReadAllText(fixture.Layout.CurrentVersionPointerPath).Trim());
    }

    [Fact]
    public async Task SignatureHashSequenceRingAndPrincipalNegativesFailClosed()
    {
        using var signatureFixture = new UpdateFixture();
        SignedBridgeUpdate tampered = signatureFixture.Release("2.0.0", sequence: 2);
        tampered.Manifest["notes"] = "unsigned mutation";
        BridgeUpdateRejectedException signature = await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
            () => signatureFixture.Engine.ApplyAsync(tampered, CancellationToken.None));
        Assert.Equal("content_hash_mismatch", signature.Code);
        Assert.False(File.Exists(signatureFixture.Layout.CurrentVersionPointerPath));

        using var signatureBytesFixture = new UpdateFixture();
        SignedBridgeUpdate invalidSignature = signatureBytesFixture.Release(
            "2.0.0",
            sequence: 2);
        byte[] signatureBytes = Convert.FromBase64String(
            invalidSignature.SignatureEnvelope.Value<string>("signature")!);
        signatureBytes[0] ^= 0x01;
        invalidSignature.SignatureEnvelope["signature"] =
            Convert.ToBase64String(signatureBytes);
        BridgeUpdateRejectedException cryptographicSignature =
            await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
                () => signatureBytesFixture.Engine.ApplyAsync(
                    invalidSignature,
                    CancellationToken.None));
        Assert.Equal("signature_verification_failed", cryptographicSignature.Code);
        Assert.False(File.Exists(signatureBytesFixture.Layout.CurrentVersionPointerPath));

        using var hashFixture = new UpdateFixture();
        SignedBridgeUpdate wrongHash = hashFixture.Release(
            "2.0.0",
            sequence: 2,
            corruptSignedBridgeHash: true);
        BridgeUpdateRejectedException hash = await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
            () => hashFixture.Engine.ApplyAsync(wrongHash, CancellationToken.None));
        Assert.Equal("component_hash_mismatch", hash.Code);
        Assert.False(File.Exists(hashFixture.Layout.CurrentVersionPointerPath));

        using var ringFixture = new UpdateFixture();
        BridgeUpdateResult skipped = await ringFixture.Engine.ApplyAsync(
            ringFixture.Release("2.0.0", sequence: 2, rolloutPercent: 0, deviceRing: 1),
            CancellationToken.None);
        Assert.Equal(BridgeUpdateDisposition.NotSelected, skipped.Disposition);
        Assert.Equal(0, (await ringFixture.State.ReadAsync(CancellationToken.None))
            .HighestAcceptedReleaseSequence);
        BridgeUpdateResult pilot = await ringFixture.Engine.ApplyAsync(
            ringFixture.Release("2.0.0", sequence: 2, rolloutPercent: 0, deviceRing: 0),
            CancellationToken.None);
        Assert.Equal(BridgeUpdateDisposition.Applied, pilot.Disposition);

        BridgeUpdateRejectedException rollback = await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
            () => ringFixture.Engine.ApplyAsync(
                ringFixture.Release("1.5.0", sequence: 1),
                CancellationToken.None));
        Assert.Equal("release_sequence_rollback", rollback.Code);

        SignedBridgeUpdate otherTenant = ringFixture.Release("3.0.0", sequence: 3) with
        {
            Principal = new BridgeUpdatePrincipal("tenant-b", "device-1", "session-2"),
        };
        BridgeUpdateRejectedException principal = await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
            () => ringFixture.Engine.ApplyAsync(otherTenant, CancellationToken.None));
        Assert.Equal("principal_binding_mismatch", principal.Code);
        Assert.All(ringFixture.Artifacts.SeenPrincipals, seen =>
        {
            Assert.Equal("tenant-a", seen.TenantBinding);
            Assert.Equal("device-1", seen.DeviceId);
        });
    }

    [Fact]
    public async Task EqualSequenceAndVersionIsIdempotent()
    {
        using var fixture = new UpdateFixture();
        SignedBridgeUpdate release = fixture.Release("2.0.0", sequence: 2);
        BridgeUpdateResult first = await fixture.Engine.ApplyAsync(
            release,
            CancellationToken.None);
        int reads = fixture.Artifacts.OpenCount;

        BridgeUpdateResult second = await fixture.Engine.ApplyAsync(
            release,
            CancellationToken.None);

        Assert.Equal(BridgeUpdateDisposition.Applied, first.Disposition);
        Assert.Equal(BridgeUpdateDisposition.AlreadyCurrent, second.Disposition);
        Assert.False(second.BridgeApplied);
        Assert.Equal(reads, fixture.Artifacts.OpenCount);

        BridgeUpdateRejectedException contentRebind =
            await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
                () => fixture.Engine.ApplyAsync(
                    fixture.Release(
                        "2.0.0",
                        sequence: 2,
                        bridgeMarker: "changed-component"),
                    CancellationToken.None));
        Assert.Equal("release_content_rebind", contentRebind.Code);

        BridgeUpdateRejectedException resequence =
            await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
                () => fixture.Engine.ApplyAsync(
                    fixture.Release("2.0.0", sequence: 3),
                    CancellationToken.None));
        Assert.Equal("active_version_resequence", resequence.Code);
    }

    [Fact]
    public async Task ExactPendingReleaseCanResumeButSequenceCannotBeRebound()
    {
        using var fixture = new UpdateFixture();
        SignedBridgeUpdate pending = fixture.Release("2.0.0", sequence: 2);
        string pendingDigest = "sha256:" +
            pending.SignatureEnvelope.Value<string>("contentSha256")!.ToLowerInvariant();
        await fixture.State.MutateAsync(
            state => state with
            {
                TenantBinding = "tenant-a",
                DeviceId = "device-1",
                AuthenticatedSessionId = "session-1",
                ActiveVersion = "1.0.0",
                HighestAcceptedReleaseSequence = 2,
                PendingReleaseVersion = "2.0.0",
                PendingReleaseSequence = 2,
                PendingManifestDigest = pendingDigest,
            },
            CancellationToken.None);

        BridgeUpdateResult resumed = await fixture.Engine.ApplyAsync(
            pending,
            CancellationToken.None);
        Assert.Equal(BridgeUpdateDisposition.Applied, resumed.Disposition);

        BridgeUpdateRejectedException rebound = await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
            () => fixture.Engine.ApplyAsync(
                fixture.Release("2.1.0", sequence: 2),
                CancellationToken.None));
        Assert.Equal("release_sequence_reuse", rebound.Code);
    }

    [Theory]
    [InlineData("device-1", 41)]
    [InlineData("NET01", 65)]
    [InlineData("pilot-alpha", 9)]
    [InlineData("00000000-0000-0000-0000-000000000001", 82)]
    [InlineData("revagent-canary-17", 91)]
    public void FullSha256RolloutModuloMatchesGoldenVectors(
        string deviceId,
        int bucket)
    {
        Assert.False(BridgeUpdateEngine.IsSelected(deviceId, 1, bucket));
        Assert.True(BridgeUpdateEngine.IsSelected(deviceId, 1, bucket + 1));
    }

    [Fact]
    public async Task InterruptedResumeRefusesChangedSignedContent()
    {
        using var fixture = new UpdateFixture();
        SignedBridgeUpdate accepted = fixture.Release("2.0.0", sequence: 2);
        string digest = "sha256:" +
            accepted.SignatureEnvelope.Value<string>("contentSha256")!.ToLowerInvariant();
        await fixture.State.MutateAsync(
            state => state with
            {
                TenantBinding = "tenant-a",
                DeviceId = "device-1",
                AuthenticatedSessionId = "session-1",
                ActiveVersion = "1.0.0",
                HighestAcceptedReleaseSequence = 2,
                PendingReleaseVersion = "2.0.0",
                PendingReleaseSequence = 2,
                PendingManifestDigest = digest,
            },
            CancellationToken.None);

        BridgeUpdateRejectedException changed =
            await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
                () => fixture.Engine.ApplyAsync(
                    fixture.Release("2.0.0", sequence: 2, notes: "changed"),
                    CancellationToken.None));
        Assert.Equal("release_content_rebind", changed.Code);
    }

    [Fact]
    public async Task AuthenticatedSessionBindingCannotBeSwappedForArtifactFetch()
    {
        var handler = new RecordingHttpHandler();
        using var http = new HttpClient(handler);
        var principal = new BridgeUpdatePrincipal(
            "tenant-bound-a",
            "device-1",
            "session-1");
        Uri manifestUri = BridgeUpdatePollingService.CreateManifestUri(
            new Uri("wss://gateway.example.test/bridge/v1"));
        var source = new AuthenticatedSessionArtifactSource(
            http,
            principal,
            manifestUri,
            "generated-device-token",
            "sha256:" + new string('a', 64));

        BridgeUpdateRejectedException mismatch =
            await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
                async () => await source.OpenReadAsync(
                    new Uri("https://objects.example.test/bridge.zip"),
                    principal with { AuthenticatedSessionId = "session-2" },
                    CancellationToken.None));
        Assert.Equal("artifact_principal_mismatch", mismatch.Code);
        Assert.Equal(0, handler.RequestCount);

        await using Stream artifact = await source.OpenReadAsync(
            new Uri("https://objects.example.test/bridge.zip"),
            principal,
            CancellationToken.None);
        Assert.Equal(1, handler.RequestCount);
        Assert.Null(handler.Authorization);
        Assert.Equal("https://gateway.example.test/bridge/update/manifest", manifestUri.AbsoluteUri);
    }

    [Fact]
    public void InstalledTrustedKeyDocumentLoadsProductionShape()
    {
        using var fixture = new UpdateFixture();
        TrustedPublicKeyRing ring = BridgeUpdatePollingService.LoadTrustedKeys(
            fixture.WriteTrustedKeysDocument());

        Assert.Equal(1, ring.Count);
    }

    private sealed class UpdateFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-eu21-{Guid.NewGuid():N}");
        private readonly RSA _rsa = RSA.Create(2048);

        internal UpdateFixture()
        {
            Layout = new BridgeInstallLayout(
                Path.Combine(_root, "revAgent", "Bridge"),
                Path.Combine(_root, "state"));
            Directory.CreateDirectory(Layout.CurrentWorkerDirectory);
            Directory.CreateDirectory(Layout.AddinRoot);
            File.WriteAllText(Layout.WorkerExecutablePath, "v1-worker");
            File.WriteAllText(AddinPayloadPath, "v1-addin");
            State = new BridgeUpdateStateStore(Layout);
            Reports = new BridgeUpdateReportStore(Layout);
            Revit = new MutableRevitProbe();
            Artifacts = new FixtureArtifactSource();
            TrustedPublicKeyRing keys = TrustedPublicKeyRing.Create(
                [TrustedKey(_rsa)]);
            Engine = new BridgeUpdateEngine(
                Layout,
                State,
                keys,
                Artifacts,
                Revit,
                "1.0.0",
                reports: Reports);
            Rollback = new CrashLoopRollbackController(
                Layout,
                State,
                Revit,
                reports: Reports);
        }

        internal BridgeInstallLayout Layout { get; }
        internal BridgeUpdateStateStore State { get; }
        internal BridgeUpdateReportStore Reports { get; }
        internal MutableRevitProbe Revit { get; }
        internal FixtureArtifactSource Artifacts { get; }
        internal BridgeUpdateEngine Engine { get; }
        internal CrashLoopRollbackController Rollback { get; }
        internal string AddinPayloadPath => Path.Combine(Layout.AddinRoot, "addin.txt");

        internal string WriteTrustedKeysDocument()
        {
            string xml = PublicXml(_rsa);
            var document = new JObject
            {
                ["trustedKeys"] = new JObject
                {
                    ["eu21-test-key"] = new JObject
                    {
                        ["publicKeyXml"] = xml,
                        ["publicKeyFingerprint"] =
                            RsaXmlPublicKey.ComputeFingerprint(xml),
                        ["algorithm"] = "RS256",
                    },
                },
            };
            string path = Path.Combine(_root, "update-trusted-keys.json");
            File.WriteAllText(path, document.ToString());
            return path;
        }

        internal SignedBridgeUpdate Release(
            string version,
            long sequence,
            int rolloutPercent = 100,
            int deviceRing = 1,
            bool corruptSignedBridgeHash = false,
            string notes = "EU-21 fixture",
            string bridgeMarker = "")
        {
            byte[] bridge = Zip((
                BridgeInstallLayout.WorkerExecutableName,
                $"v{version[0]}-worker{bridgeMarker}"));
            byte[] addin = Zip(("addin.txt", $"v{version[0]}-addin"));
            Uri bridgeUrl = new($"https://updates.example.test/{version}/bridge.zip");
            Uri addinUrl = new($"https://updates.example.test/{version}/addin.zip");
            Artifacts.Add(bridgeUrl, bridge);
            Artifacts.Add(addinUrl, addin);

            var manifest = new JObject
            {
                ["schemaVersion"] = 1,
                ["channel"] = "stable",
                ["version"] = version,
                ["releaseSequence"] = sequence,
                ["components"] = new JArray(
                    Component(
                        "bridge",
                        version,
                        bridgeUrl,
                        bridge,
                        corruptSignedBridgeHash),
                    Component("addin", version, addinUrl, addin, false)),
                ["rolloutPercent"] = rolloutPercent,
                ["minSupportedVersion"] = "1.0.0",
                ["notes"] = notes,
            };
            return new SignedBridgeUpdate(
                manifest,
                Envelope(_rsa, manifest),
                new BridgeUpdatePrincipal("tenant-a", "device-1", "session-1"),
                deviceRing);
        }

        public void Dispose()
        {
            _rsa.Dispose();
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }

        private static JObject Component(
            string name,
            string version,
            Uri url,
            byte[] bytes,
            bool corruptHash)
        {
            string hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (corruptHash)
            {
                hash = new string('0', 64);
            }

            return new JObject
            {
                ["name"] = name,
                ["version"] = version,
                ["sha256"] = hash,
                ["sizeBytes"] = bytes.LongLength,
                ["url"] = url.AbsoluteUri,
            };
        }

        private static byte[] Zip(params (string Name, string Content)[] files)
        {
            using var memory = new MemoryStream();
            using (var archive = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach ((string name, string content) in files)
                {
                    ZipArchiveEntry entry = archive.CreateEntry(name, CompressionLevel.NoCompression);
                    using StreamWriter writer = new(entry.Open(), new UTF8Encoding(false));
                    writer.Write(content);
                }
            }

            return memory.ToArray();
        }

        private static JObject Envelope(RSA rsa, JToken content)
        {
            string publicXml = PublicXml(rsa);
            var envelope = new JObject
            {
                ["schemaVersion"] = DetachedSignatureContract.SchemaVersion,
                ["app"] = DetachedSignatureContract.App,
                ["signedObject"] = DetachedSignatureContract.BridgeManifestSignedObject,
                ["algorithm"] = DetachedSignatureContract.Algorithm,
                ["keyId"] = "eu21-test-key",
                ["publicKeyFingerprint"] = RsaXmlPublicKey.ComputeFingerprint(publicXml),
                ["canonicalization"] = DetachedSignatureContract.Canonicalization,
                ["contentSha256"] = CanonicalJson.Sha256Hex(content),
                ["createdAtUtc"] = "2026-09-07T00:00:00.0000000Z",
                ["signature"] = string.Empty,
            };
            byte[] payload = Encoding.UTF8.GetBytes(
                CanonicalJson.Serialize(DetachedSignatureProjection.Create(envelope)));
            envelope["signature"] = Convert.ToBase64String(
                rsa.SignData(payload, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
            return envelope;
        }

        private static TrustedPublicKey TrustedKey(RSA rsa)
        {
            string xml = PublicXml(rsa);
            return new TrustedPublicKey(
                "eu21-test-key",
                xml,
                RsaXmlPublicKey.ComputeFingerprint(xml));
        }

        private static string PublicXml(RSA rsa)
        {
            RSAParameters key = rsa.ExportParameters(includePrivateParameters: false);
            return "<RSAKeyValue><Modulus>" + Convert.ToBase64String(key.Modulus!) +
                "</Modulus><Exponent>" + Convert.ToBase64String(key.Exponent!) +
                "</Exponent></RSAKeyValue>";
        }
    }

    private sealed class FixtureArtifactSource : IBridgeUpdateArtifactSource
    {
        private readonly Dictionary<Uri, byte[]> _artifacts = [];

        internal List<BridgeUpdatePrincipal> SeenPrincipals { get; } = [];
        internal int OpenCount { get; private set; }

        internal void Add(Uri uri, byte[] content) => _artifacts[uri] = content;

        public ValueTask<Stream> OpenReadAsync(
            Uri artifactUri,
            BridgeUpdatePrincipal principal,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            OpenCount++;
            SeenPrincipals.Add(principal);
            return ValueTask.FromResult<Stream>(
                new MemoryStream(_artifacts[artifactUri], writable: false));
        }
    }

    private sealed class MutableRevitProbe : IRevitProcessProbe
    {
        internal bool IsRunning { get; set; }
        public bool IsRevitRunning() => IsRunning;
    }

    private sealed class RecordingHttpHandler : HttpMessageHandler
    {
        internal int RequestCount { get; private set; }
        internal AuthenticationHeaderValue? Authorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RequestCount++;
            Authorization = request.Headers.Authorization;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new ByteArrayContent([1, 2, 3]),
            });
        }
    }
}

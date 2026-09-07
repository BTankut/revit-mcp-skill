using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Bootstrap.Updates;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Update;
using RevAgent.Contracts.Signing;

namespace RevAgent.Bridge.Tests.Update;

public sealed class ComposedBridgeUpdateMatrixTests
{
    [Fact]
    public async Task RealPollerConsumesGeneratedReleaseOverAuthenticatedLoopbackHttps()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"revagent-eu21-https-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            InstallerFixture installer = await PrepareInstallerFixtureAsync(root);
            var layout = new BridgeInstallLayout(installer.InstallRoot, installer.StateRoot);
            byte[] bridgeZip = Zip((BridgeInstallLayout.WorkerExecutableName, "https-worker"));
            byte[] addinZip = Zip(("2022/revAgentPlugin/revAgentPlugin.dll", "https-addin"));
            using RSA signingKey = ReadPrivateKey(installer.PrivateKeyPath);
            await using var server = new LocalHttpsUpdateServer(bridgeZip, addinZip);
            JObject manifest = Manifest(bridgeZip, addinZip, "2.0.0", 2, server.BaseUri);
            JObject envelope = Envelope(signingKey, manifest);
            server.SetManifest(manifest, envelope);
            await server.StartAsync();

            await using var log = new NullBridgeLog();
            var state = new BridgeUpdateStateStore(layout);
            var reports = new BridgeUpdateReportStore(layout);
            var launcher = new ComposedWorkerLauncher();
            var rollback = new CrashLoopRollbackController(layout, state, new MutableRevitProbe(), reports: reports);
            await using var supervisor = new WorkerSupervisor(layout, launcher, log, rollbackController: rollback);
            var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
            handler.ServerCertificateCustomValidationCallback = (_, certificate, _, errors) =>
                errors == SslPolicyErrors.None || certificate?.GetCertHashString() == server.CertificateThumbprint;
            var poller = new BridgeUpdatePollingService(
                layout, state, supervisor, log, reports,
                httpClientFactory: () => new HttpClient(handler, disposeHandler: false),
                revit: new MutableRevitProbe());
            string machineFingerprint = "sha256:" + new string('d', 64);
            string deviceId = "10000000-0000-4000-8000-000000000003";
            var principal = new BridgeUpdatePrincipal(
                BridgeUpdatePollingService.CreateTenantBinding(machineFingerprint, deviceId),
                deviceId,
                "30000000-0000-4000-8000-000000000001");
            var context = new BridgeUpdatePollContext(
                server.BaseUri,
                principal,
                "generated-https-device-token",
                machineFingerprint,
                BridgeUpdatePollingService.LoadTrustedKeys(installer.TrustedKeysPath),
                "1.0.0");

            BridgeUpdateResult result = await poller.CheckOnceAsync(context, CancellationToken.None);
            Assert.Equal(BridgeUpdateDisposition.Applied, result.Disposition);
            Assert.Equal("https-worker", await File.ReadAllTextAsync(
                WorkerExecutableResolver.Resolve(layout).ExecutablePath));
            Assert.Equal("https-addin", await File.ReadAllTextAsync(Path.Combine(
                layout.AddinRoot, "2022", "revAgentPlugin", "revAgentPlugin.dll")));
            Assert.Equal(3, server.Requests.Count);
            Assert.All(server.Requests, request =>
            {
                Assert.Equal("Bearer generated-https-device-token", request.Authorization);
                Assert.Equal(deviceId, request.DeviceId);
                Assert.Equal(machineFingerprint, request.MachineFingerprint);
            });
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
    public async Task InstallerPollerHostCrashRollbackAndGatewayReportMatrix()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-eu21-composed-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            InstallerFixture installer = await PrepareInstallerFixtureAsync(root);
            using JsonDocument installerReport = JsonDocument.Parse(
                await File.ReadAllTextAsync(installer.ReportPath));
            Assert.Equal(
                "success",
                installerReport.RootElement.GetProperty("status").GetString());

            var layout = new BridgeInstallLayout(
                installer.InstallRoot,
                installer.StateRoot);
            Assert.Equal("v1-worker", await File.ReadAllTextAsync(layout.WorkerExecutablePath));
            string addinPath = Path.Combine(
                layout.AddinRoot,
                "2022",
                "revAgentPlugin",
                "revAgentPlugin.dll");
            Assert.Equal("v1-addin", await File.ReadAllTextAsync(addinPath));

            using RSA rsa = ReadPrivateKey(installer.PrivateKeyPath);
            byte[] bridgeZip = Zip((BridgeInstallLayout.WorkerExecutableName, "v2-worker"));
            byte[] addinZip = Zip((
                "2022/revAgentPlugin/revAgentPlugin.dll",
                "v2-addin"));
            JObject manifest = Manifest(bridgeZip, addinZip, "2.0.0", 2);
            JObject envelope = Envelope(rsa, manifest);
            var gateway = new ComposedUpdateHttpHandler(
                manifest,
                envelope,
                bridgeZip,
                addinZip,
                expectedBearer: "eu21-composed-bearer-token");
            var state = new BridgeUpdateStateStore(layout);
            var reports = new BridgeUpdateReportStore(layout);
            var revit = new MutableRevitProbe { IsRunning = true };
            var launcher = new ComposedWorkerLauncher();
            await using var log = new NullBridgeLog();
            var rollback = new CrashLoopRollbackController(
                layout,
                state,
                revit,
                reports: reports);
            await using var supervisor = new WorkerSupervisor(
                layout,
                launcher,
                log,
                rollbackController: rollback);
            var poller = new BridgeUpdatePollingService(
                layout,
                state,
                supervisor,
                log,
                reports,
                httpClientFactory: () => new HttpClient(gateway, disposeHandler: false),
                revit: revit);
            var principal = new BridgeUpdatePrincipal(
                BridgeUpdatePollingService.CreateTenantBinding(
                    "sha256:" + new string('b', 64),
                    "10000000-0000-4000-8000-000000000003"),
                "10000000-0000-4000-8000-000000000003",
                "30000000-0000-4000-8000-000000000001");
            var pollContext = new BridgeUpdatePollContext(
                new Uri("wss://gateway.example.test/bridge/v1"),
                principal,
                "eu21-composed-bearer-token",
                "sha256:" + new string('b', 64),
                BridgeUpdatePollingService.LoadTrustedKeys(installer.TrustedKeysPath),
                "1.0.0");
            SignatureVerificationResult directSignature =
                DetachedSignatureVerifier.Verify(
                    manifest,
                    envelope,
                    pollContext.TrustedKeys,
                    DetachedSignaturePolicy.BridgeManifest);
            Assert.True(directSignature.Success, directSignature.Message);

            await supervisor.StartAsync(CancellationToken.None);
            Task<WorkerExit> monitor = supervisor.WaitForExitAsync(CancellationToken.None);
            BridgeUpdateResult update = await poller.PollAndRestartOnceAsync(
                pollContext,
                CancellationToken.None);
            Assert.Equal(BridgeUpdateDisposition.DeferredForRevitClose, update.Disposition);
            Assert.Equal("v1-addin", await File.ReadAllTextAsync(addinPath));
            Assert.Equal("2.0.0", (await File.ReadAllTextAsync(
                layout.CurrentVersionPointerPath)).Trim());

            revit.IsRunning = false;
            var addinApplier = new PendingAddinApplier(
                layout,
                state,
                revit,
                reports);
            Assert.True(await addinApplier.TryApplyAsync(CancellationToken.None));
            Assert.Equal("v2-addin", await File.ReadAllTextAsync(addinPath));

            using var startupTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            while (launcher.StartCount < 5)
            {
                await Task.Delay(20, startupTimeout.Token);
            }

            BridgeUpdateState finalState = await state.ReadAsync(CancellationToken.None);
            Assert.Equal("1.0.0", finalState.ActiveVersion);
            Assert.Contains("2.0.0", finalState.QuarantinedVersions.Keys);
            Assert.Equal("1.0.0", (await File.ReadAllTextAsync(
                layout.CurrentVersionPointerPath)).Trim());
            Assert.Equal("v1-worker", await File.ReadAllTextAsync(
                WorkerExecutableResolver.Resolve(layout).ExecutablePath));
            Assert.Equal("v1-addin", await File.ReadAllTextAsync(addinPath));

            gateway.SetResponse(
                Manifest(bridgeZip, addinZip, "3.0.0", 3),
                envelope);
            BridgeUpdateRejectedException refused =
                await Assert.ThrowsAsync<BridgeUpdateRejectedException>(
                    () => poller.CheckOnceAsync(pollContext, CancellationToken.None));
            Assert.Equal("content_hash_mismatch", refused.Code);

            IReadOnlyList<BridgeUpdateReport> pending =
                await reports.ReadPendingAsync(CancellationToken.None);
            IReadOnlyList<BridgeUpdateReport> outbound =
                BridgeUpdateHeartbeatReports.Bound(pending);
            object[] wireRows = BridgeUpdateHeartbeatReports.ToWireRows(outbound);
            GatewayReportReceipt receipt = ComposedGatewayReceiver.Persist(
                principal.DeviceId,
                JsonSerializer.SerializeToElement(wireRows));
            Assert.Throws<InvalidDataException>(() =>
                BridgeUpdateHeartbeatReports.Acknowledge(
                    reports,
                    outbound.Select(report => report.ReportId).ToArray(),
                    ["40000000-0000-4000-8000-000000000099"]));
            Assert.Equal(pending.Count, (await reports.ReadPendingAsync(
                CancellationToken.None)).Count);
            BridgeUpdateHeartbeatReports.Acknowledge(
                reports,
                outbound.Select(report => report.ReportId).ToArray(),
                receipt.AcknowledgedReportIds);
            Assert.Empty(await reports.ReadPendingAsync(CancellationToken.None));
            Assert.Equal(
                ["applied", "deferred", "quarantined", "refused", "rollback", "staged"],
                receipt.States.Order(StringComparer.Ordinal).ToArray());
            Assert.True(gateway.ManifestAuthorizationVerified);
            Assert.True(gateway.ManifestDeviceClaimsVerified);
            Assert.True(gateway.ArtifactBearerWasAbsent);

            _ = await supervisor.StopAsync(
                WorkerStopReason.HostShutdown,
                TimeSpan.FromSeconds(2),
                CancellationToken.None);
            WorkerExit exit = await monitor;
            Assert.False(exit.RestartBudgetExhausted);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    private static async Task<InstallerFixture> PrepareInstallerFixtureAsync(string root)
    {
        string repo = FindRepoRoot();
        string script = Path.Combine(
            repo,
            "packages",
            "bridge",
            "tests",
            "fixtures",
            "prepare-eu21-installer-fixture.ps1");
        var start = new ProcessStartInfo
        {
            FileName = "pwsh.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (string argument in new[] { "-NoProfile", "-File", script, "-RepoRoot", repo, "-Root", root })
        {
            start.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(start) ??
            throw new InvalidOperationException("PowerShell fixture process did not start.");
        string stdout = await process.StandardOutput.ReadToEndAsync();
        string stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, stderr);
        return JsonSerializer.Deserialize<InstallerFixture>(stdout.Trim(), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidDataException("Installer fixture output is empty.");
    }

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(
                    current.FullName,
                    "installer",
                    "bridge",
                    "Install-RevAgentBridge.ps1")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("Repository root was not found.");
    }

    private static JObject Manifest(
        byte[] bridge,
        byte[] addin,
        string version,
        long sequence,
        Uri? artifactBase = null) => new()
        {
            ["schemaVersion"] = 1,
            ["channel"] = "stable",
            ["version"] = version,
            ["releaseSequence"] = sequence,
            ["components"] = new JArray(
            Component("bridge", version, artifactBase is null ? "https://objects.example.test/bridge.zip" : new Uri(artifactBase, "/bridge/update/artifact/release/bridge").AbsoluteUri, bridge),
            Component("addin", version, artifactBase is null ? "https://objects.example.test/addin.zip" : new Uri(artifactBase, "/bridge/update/artifact/release/addin").AbsoluteUri, addin)),
            ["rolloutPercent"] = 100,
            ["minSupportedVersion"] = "1.0.0",
            ["notes"] = "composed EU-21 matrix",
        };

    private static JObject Component(
        string name,
        string version,
        string url,
        byte[] bytes) => new()
        {
            ["name"] = name,
            ["version"] = version,
            ["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            ["sizeBytes"] = bytes.LongLength,
            ["url"] = url,
        };

    private static JObject Envelope(RSA rsa, JToken content)
    {
        RSAParameters publicKey = rsa.ExportParameters(includePrivateParameters: false);
        string publicXml = "<RSAKeyValue><Modulus>" +
            Convert.ToBase64String(publicKey.Modulus!) +
            "</Modulus><Exponent>" +
            Convert.ToBase64String(publicKey.Exponent!) +
            "</Exponent></RSAKeyValue>";
        var envelope = new JObject
        {
            ["schemaVersion"] = 1,
            ["app"] = "revAgent",
            ["signedObject"] = "bridge-manifest",
            ["algorithm"] = "RS256",
            ["keyId"] = "eu21-composed-test-key",
            ["publicKeyFingerprint"] = RsaXmlPublicKey.ComputeFingerprint(publicXml),
            ["canonicalization"] = DetachedSignatureContract.Canonicalization,
            ["contentSha256"] = CanonicalJson.Sha256Hex(content),
            ["createdAtUtc"] = "2026-09-07T18:00:00.0000000Z",
            ["signature"] = string.Empty,
        };
        byte[] signed = Encoding.UTF8.GetBytes(
            CanonicalJson.Serialize(DetachedSignatureProjection.Create(envelope)));
        envelope["signature"] = Convert.ToBase64String(
            rsa.SignData(signed, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        return envelope;
    }

    private static RSA ReadPrivateKey(string path)
    {
        XElement root = XDocument.Parse(File.ReadAllText(path)).Root!;
        byte[] Read(string name) => Convert.FromBase64String(root.Element(name)!.Value);
        var parameters = new RSAParameters
        {
            Modulus = Read("Modulus"),
            Exponent = Read("Exponent"),
            D = Read("D"),
            P = Read("P"),
            Q = Read("Q"),
            DP = Read("DP"),
            DQ = Read("DQ"),
            InverseQ = Read("InverseQ"),
        };
        RSA rsa = RSA.Create();
        rsa.ImportParameters(parameters);
        return rsa;
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

    private sealed record InstallerFixture(
        string InstallRoot,
        string StateRoot,
        string AddinRoot,
        string RevitAddinsRoot,
        string ReportPath,
        string PrivateKeyPath,
        string TrustedKeysPath);

    private sealed class MutableRevitProbe : IRevitProcessProbe
    {
        internal bool IsRunning { get; set; }
        public bool IsRevitRunning() => IsRunning;
    }

    private sealed class ComposedUpdateHttpHandler : HttpMessageHandler
    {
        private readonly byte[] _bridge;
        private readonly byte[] _addin;
        private readonly string _expectedBearer;
        private JObject _manifest;
        private JObject _envelope;

        internal ComposedUpdateHttpHandler(
            JObject manifest,
            JObject envelope,
            byte[] bridge,
            byte[] addin,
            string expectedBearer)
        {
            _manifest = manifest;
            _envelope = envelope;
            _bridge = bridge;
            _addin = addin;
            _expectedBearer = expectedBearer;
        }

        internal bool ManifestAuthorizationVerified { get; private set; }
        internal bool ManifestDeviceClaimsVerified { get; private set; }
        internal bool ArtifactBearerWasAbsent { get; private set; }

        internal void SetResponse(JObject manifest, JObject envelope)
        {
            _manifest = manifest;
            _envelope = envelope;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (request.RequestUri!.AbsolutePath == "/bridge/update/manifest")
            {
                ManifestAuthorizationVerified |=
                    request.Headers.Authorization?.Scheme == "Bearer" &&
                    request.Headers.Authorization.Parameter == _expectedBearer;
                ManifestDeviceClaimsVerified |=
                    request.Headers.GetValues("x-revagent-device-id").Single() ==
                        "10000000-0000-4000-8000-000000000003" &&
                    request.Headers.GetValues("x-revagent-machine-fingerprint").Single() ==
                        "sha256:" + new string('b', 64);
                var wrapper = new JObject
                {
                    ["manifest"] = _manifest.DeepClone(),
                    ["signatureEnvelope"] = _envelope.DeepClone(),
                    ["deviceRing"] = 1,
                };
                return Json(wrapper.ToString(Newtonsoft.Json.Formatting.None));
            }

            ArtifactBearerWasAbsent |= request.Headers.Authorization is null;
            byte[] bytes = request.RequestUri.AbsolutePath.EndsWith(
                "bridge.zip",
                StringComparison.Ordinal)
                ? _bridge
                : _addin;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(bytes),
            });
        }

        private static Task<HttpResponseMessage> Json(string json) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            });
    }

    private sealed record HttpsRequest(
        string Path,
        string? Authorization,
        string? DeviceId,
        string? MachineFingerprint);

    private sealed class LocalHttpsUpdateServer : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly X509Certificate2 _certificate;
        private readonly byte[] _bridge;
        private readonly byte[] _addin;
        private Task? _server;
        private JObject? _manifest;
        private JObject? _envelope;

        internal LocalHttpsUpdateServer(byte[] bridge, byte[] addin)
        {
            _bridge = bridge;
            _addin = addin;
            using RSA rsa = RSA.Create(2048);
            var request = new CertificateRequest(
                "CN=127.0.0.1",
                rsa,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder();
            names.AddIpAddress(IPAddress.Loopback);
            request.CertificateExtensions.Add(names.Build());
            using X509Certificate2 generated = request.CreateSelfSigned(
                DateTimeOffset.UtcNow.AddMinutes(-1),
                DateTimeOffset.UtcNow.AddHours(1));
            _certificate = new X509Certificate2(generated.Export(X509ContentType.Pfx));
            _listener.Start();
            BaseUri = new Uri($"https://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}/");
        }

        internal Uri BaseUri { get; }
        internal string CertificateThumbprint => _certificate.GetCertHashString();
        internal List<HttpsRequest> Requests { get; } = [];

        internal void SetManifest(JObject manifest, JObject envelope)
        {
            _manifest = manifest;
            _envelope = envelope;
        }

        internal Task StartAsync()
        {
            _server = ServeAsync(_stop.Token);
            return Task.CompletedTask;
        }

        private async Task ServeAsync(CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    using TcpClient client = await _listener.AcceptTcpClientAsync(cancellationToken);
                    await using var tls = new SslStream(client.GetStream(), leaveInnerStreamOpen: false);
                    await tls.AuthenticateAsServerAsync(
                        _certificate,
                        clientCertificateRequired: false,
                        enabledSslProtocols: System.Security.Authentication.SslProtocols.Tls12 |
                            System.Security.Authentication.SslProtocols.Tls13,
                        checkCertificateRevocation: false);
                    using var reader = new StreamReader(tls, Encoding.ASCII, false, 4096, leaveOpen: true);
                    string requestLine = await reader.ReadLineAsync(cancellationToken) ?? string.Empty;
                    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    while (await reader.ReadLineAsync(cancellationToken) is string line && line.Length != 0)
                    {
                        int colon = line.IndexOf(':');
                        if (colon > 0) headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
                    }
                    string path = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(1) ?? string.Empty;
                    Requests.Add(new HttpsRequest(
                        path,
                        headers.GetValueOrDefault("Authorization"),
                        headers.GetValueOrDefault("x-revagent-device-id"),
                        headers.GetValueOrDefault("x-revagent-machine-fingerprint")));
                    byte[] body;
                    string contentType;
                    if (path == "/bridge/update/manifest")
                    {
                        body = Encoding.UTF8.GetBytes(new JObject
                        {
                            ["manifest"] = _manifest!.DeepClone(),
                            ["signatureEnvelope"] = _envelope!.DeepClone(),
                            ["deviceRing"] = 1,
                        }.ToString(Newtonsoft.Json.Formatting.None));
                        contentType = "application/json";
                    }
                    else
                    {
                        body = path.EndsWith("/bridge", StringComparison.Ordinal) ? _bridge : _addin;
                        contentType = "application/zip";
                    }
                    byte[] response = Encoding.ASCII.GetBytes(
                        $"HTTP/1.1 200 OK\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                    await tls.WriteAsync(response, cancellationToken);
                    await tls.WriteAsync(body, cancellationToken);
                    await tls.FlushAsync(cancellationToken);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            if (_server is not null)
            {
                try { await _server; } catch (SocketException) when (_stop.IsCancellationRequested) { }
            }
            _certificate.Dispose();
            _stop.Dispose();
        }
    }

    private sealed class ComposedWorkerLauncher : IWorkerProcessLauncher
    {
        private int _starts;

        internal int StartCount => Volatile.Read(ref _starts);

        public IWorkerProcess Start(WorkerStartRequest request)
        {
            int start = Interlocked.Increment(ref _starts);
            var process = new FakeWorkerProcess(Environment.ProcessId);
            string pipe = ValueAfter(request.Arguments, "--control-pipe");
            int hostPid = int.Parse(ValueAfter(request.Arguments, "--host-pid"));
            Guid instance = Guid.Parse(ValueAfter(request.Arguments, "--instance-id"));
            string version = VersionAt(request.ExecutablePath);
            _ = RunAsync(process, pipe, hostPid, instance, version, start);
            return process;
        }

        public ValueTask<WorkerCommandResult> RunOneShotAsync(
            WorkerOneShotRequest request,
            TimeSpan timeout,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new WorkerCommandResult(
                0,
                VersionAt(request.ExecutablePath) + Environment.NewLine,
                string.Empty,
                false,
                false));

        private static async Task RunAsync(
            FakeWorkerProcess process,
            string pipe,
            int hostPid,
            Guid instance,
            string version,
            int start)
        {
            if (start == 2)
            {
                await Task.Delay(20);
                process.Complete(42);
                return;
            }

            await using ControlConnection connection =
                await WorkerControlClient.ConnectAsync(
                    pipe,
                    hostPid,
                    instance,
                    CancellationToken.None);
            if (start == 3)
            {
                await Task.Delay(20);
                process.Complete(42);
                return;
            }

            await connection.SendAsync(
                new WorkerReady(ControlProtocol.Version, instance, process.Id, version),
                CancellationToken.None);
            if (start == 4)
            {
                await Task.Delay(50);
                process.Complete(42);
                return;
            }

            ControlMessage? message = await connection.ReceiveAsync(CancellationToken.None);
            if (message is StopWorker)
            {
                await connection.SendAsync(
                    new WorkerStopping(ControlProtocol.Version, instance, process.Id),
                    CancellationToken.None);
                process.Complete(0);
            }
        }

        private static string VersionAt(string executablePath) =>
            File.ReadAllText(executablePath).Contains("v2-worker", StringComparison.Ordinal)
                ? "2.0.0"
                : "1.0.0";

        private static string ValueAfter(IReadOnlyList<string> values, string name)
        {
            for (int index = 0; index < values.Count - 1; index++)
            {
                if (string.Equals(values[index], name, StringComparison.Ordinal))
                {
                    return values[index + 1];
                }
            }

            throw new InvalidOperationException($"Worker argument '{name}' is missing.");
        }
    }

    private sealed class FakeWorkerProcess : IWorkerProcess
    {
        private readonly TaskCompletionSource<int> _exit =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal FakeWorkerProcess(int id) => Id = id;
        public int Id { get; }
        public Task<int> WaitForExitAsync(CancellationToken cancellationToken) =>
            _exit.Task.WaitAsync(cancellationToken);
        public ValueTask<WorkerProcessDiagnostics> GetDiagnosticsAsync() =>
            ValueTask.FromResult(new WorkerProcessDiagnostics("", "", false, false));
        public void KillTree() => Complete(-9);
        internal void Complete(int exitCode) => _exit.TrySetResult(exitCode);
        public void Dispose() { }
    }

    private sealed class NullBridgeLog : IBridgeLog
    {
        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default) => ValueTask.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed record GatewayReportReceipt(
        IReadOnlyList<string> AcknowledgedReportIds,
        IReadOnlyList<string> States);

    private static class ComposedGatewayReceiver
    {
        internal static GatewayReportReceipt Persist(
            string authenticatedDeviceId,
            JsonElement rows)
        {
            var ids = new List<string>();
            var states = new List<string>();
            foreach (JsonElement row in rows.EnumerateArray())
            {
                Assert.Equal(
                    authenticatedDeviceId,
                    row.GetProperty("device_id").GetString());
                ids.Add(row.GetProperty("report_id").GetString()!);
                states.Add(row.GetProperty("state").GetString()!);
            }

            return new GatewayReportReceipt(ids, states);
        }
    }
}

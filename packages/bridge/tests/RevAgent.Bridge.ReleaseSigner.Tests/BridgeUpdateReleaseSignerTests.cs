using System.Security.Cryptography;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Signing;
using Xunit;

namespace RevAgent.Bridge.ReleaseSigner.Tests;

public sealed class BridgeUpdateReleaseSignerTests
{
    [Fact]
    public void SignsExactBridgeManifestAndVerifiesWithSharedContract()
    {
        using RSA rsa = RSA.Create(2048);
        (string privateXml, string publicXml) = XmlKeys(rsa);
        string fingerprint = RsaXmlPublicKey.ComputeFingerprint(publicXml);
        JObject trusted = Trusted(publicXml, fingerprint);
        JObject manifest = Manifest();

        BridgeUpdateSignature result = BridgeUpdateReleaseSigner.Sign(
            manifest,
            "generated-p3t12",
            privateXml,
            trusted,
            DateTimeOffset.Parse("2026-09-07T12:34:56.0000000Z"));

        SignatureVerificationResult verification = DetachedSignatureVerifier.Verify(
            manifest,
            result.Envelope,
            TrustedPublicKeyRing.Create(
                [new TrustedPublicKey("generated-p3t12", publicXml, fingerprint)]),
            DetachedSignaturePolicy.BridgeManifest);
        Assert.True(verification.Success);
        Assert.Equal(CanonicalJson.Sha256Hex(manifest), result.ContentSha256);
        Assert.Equal(10, result.Envelope.Properties().Count());
    }

    [Fact]
    public void SignatureIsDeterministicAndTamperFailsClosed()
    {
        using RSA rsa = RSA.Create(2048);
        (string privateXml, string publicXml) = XmlKeys(rsa);
        string fingerprint = RsaXmlPublicKey.ComputeFingerprint(publicXml);
        JObject manifest = Manifest();
        JObject trusted = Trusted(publicXml, fingerprint);
        DateTimeOffset created = DateTimeOffset.Parse("2026-09-07T12:34:56.0000000Z");

        BridgeUpdateSignature first = BridgeUpdateReleaseSigner.Sign(
            manifest, "generated-p3t12", privateXml, trusted, created);
        BridgeUpdateSignature second = BridgeUpdateReleaseSigner.Sign(
            manifest, "generated-p3t12", privateXml, trusted, created);
        Assert.Equal(
            first.Envelope.Value<string>("signature"),
            second.Envelope.Value<string>("signature"));

        manifest["releaseSequence"] = 43;
        SignatureVerificationResult verification = DetachedSignatureVerifier.Verify(
            manifest,
            first.Envelope,
            TrustedPublicKeyRing.Create(
                [new TrustedPublicKey("generated-p3t12", publicXml, fingerprint)]),
            DetachedSignaturePolicy.BridgeManifest);
        Assert.False(verification.Success);
        Assert.Equal("content_hash_mismatch", verification.Reason);
    }

    [Fact]
    public void RefusesWrongPrivateKeyAndUnexpectedManifestField()
    {
        using RSA trustedRsa = RSA.Create(2048);
        using RSA wrongRsa = RSA.Create(2048);
        (string _, string publicXml) = XmlKeys(trustedRsa);
        (string wrongPrivate, string _) = XmlKeys(wrongRsa);
        string fingerprint = RsaXmlPublicKey.ComputeFingerprint(publicXml);

        Assert.Throws<InvalidDataException>(() => BridgeUpdateReleaseSigner.Sign(
            Manifest(),
            "generated-p3t12",
            wrongPrivate,
            Trusted(publicXml, fingerprint),
            DateTimeOffset.Parse("2026-09-07T12:34:56.0000000Z")));

        (string privateXml, string _) = XmlKeys(trustedRsa);
        JObject extra = Manifest();
        extra["unsigned"] = true;
        Assert.Throws<InvalidDataException>(() => BridgeUpdateReleaseSigner.Sign(
            extra,
            "generated-p3t12",
            privateXml,
            Trusted(publicXml, fingerprint),
            DateTimeOffset.Parse("2026-09-07T12:34:56.0000000Z")));
    }

    [Fact]
    public void AtomicWriterNeverOverwritesExistingEnvelope()
    {
        string root = Path.Combine(Path.GetTempPath(), "revagent-p3t12-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string output = Path.Combine(root, "bridge-manifest.signature.json");
        try
        {
            BridgeUpdateReleaseSigner.WriteEnvelopeAtomic(output, new JObject { ["value"] = 1 });
            Assert.Throws<IOException>(() =>
                BridgeUpdateReleaseSigner.WriteEnvelopeAtomic(output, new JObject { ["value"] = 2 }));
            Assert.Equal(1, JObject.Parse(File.ReadAllText(output)).Value<int>("value"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static JObject Manifest() => new()
    {
        ["schemaVersion"] = 1,
        ["channel"] = "pilot",
        ["version"] = "3.0.0",
        ["releaseSequence"] = 42,
        ["components"] = new JArray
        {
            new JObject
            {
                ["name"] = "bridge",
                ["version"] = "3.0.0",
                ["sha256"] = new string('a', 64),
                ["sizeBytes"] = 123,
                ["url"] = "https://gateway.example/bridge/update/artifact/42/bridge",
            },
            new JObject
            {
                ["name"] = "addin",
                ["version"] = "3.0.0",
                ["sha256"] = new string('b', 64),
                ["sizeBytes"] = 456,
                ["url"] = "https://gateway.example/bridge/update/artifact/42/addin",
            },
        },
        ["rolloutPercent"] = 100,
        ["minSupportedVersion"] = "2.0.0",
        ["notes"] = "generated-key fixture",
    };

    private static JObject Trusted(string publicXml, string fingerprint) => new()
    {
        ["trustedKeys"] = new JObject
        {
            ["generated-p3t12"] = new JObject
            {
                ["publicKeyXml"] = publicXml,
                ["publicKeyFingerprint"] = fingerprint,
                ["algorithm"] = DetachedSignatureContract.Algorithm,
            },
        },
    };

    private static (string Private, string Public) XmlKeys(RSA rsa)
    {
        RSAParameters key = rsa.ExportParameters(includePrivateParameters: true);
        string Element(string name, byte[]? bytes) =>
            $"<{name}>{Convert.ToBase64String(bytes!)}</{name}>";
        string publicXml = "<RSAKeyValue>" + Element("Modulus", key.Modulus) +
            Element("Exponent", key.Exponent) + "</RSAKeyValue>";
        string privateXml = "<RSAKeyValue>" +
            Element("Modulus", key.Modulus) + Element("Exponent", key.Exponent) +
            Element("P", key.P) + Element("Q", key.Q) + Element("DP", key.DP) +
            Element("DQ", key.DQ) + Element("InverseQ", key.InverseQ) +
            Element("D", key.D) + "</RSAKeyValue>";
        return (privateXml, publicXml);
    }
}

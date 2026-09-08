using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Signing;

namespace RevAgent.Bridge.ReleaseSigner;

public sealed record BridgeUpdateSignature(
    JObject Envelope,
    string SignedObject,
    string KeyId,
    string ContentSha256,
    string PublicKeyFingerprint,
    string CanonicalProjectionSha256);

public static class BridgeUpdateReleaseSigner
{
    private static readonly HashSet<string> ManifestFields = new(
        [
            "schemaVersion", "channel", "version", "releaseSequence",
            "components", "rolloutPercent", "minSupportedVersion", "notes",
        ],
        StringComparer.Ordinal);
    private static readonly HashSet<string> ComponentFields = new(
        ["name", "version", "sha256", "sizeBytes", "url"],
        StringComparer.Ordinal);

    public static BridgeUpdateSignature Sign(
        JObject content,
        string keyId,
        string privateKeyXml,
        JObject trustedKeyDocument,
        DateTimeOffset createdAtUtc)
    {
        ArgumentNullException.ThrowIfNull(content);
        ArgumentNullException.ThrowIfNull(trustedKeyDocument);
        ValidateManifest(content);
        if (!IsIdentifier(keyId))
        {
            throw new InvalidDataException("Signing keyId is invalid.");
        }

        JObject trustedKeys = trustedKeyDocument["trustedKeys"] as JObject
            ?? trustedKeyDocument;
        if (trustedKeys[keyId] is not JObject trusted ||
            trusted.Value<string>("publicKeyXml") is not string publicKeyXml ||
            trusted.Value<string>("publicKeyFingerprint") is not string trustedFingerprint ||
            !string.Equals(
                trusted.Value<string>("algorithm"),
                DetachedSignatureContract.Algorithm,
                StringComparison.Ordinal))
        {
            throw new InvalidDataException("The requested signing key is not pinned in the trusted-key document.");
        }

        string computedFingerprint = RsaXmlPublicKey.ComputeFingerprint(publicKeyXml);
        if (!string.Equals(computedFingerprint, trustedFingerprint, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Trusted-key fingerprint does not match its public key.");
        }

        using RSA rsa = RSA.Create();
        rsa.ImportParameters(ParsePrivateKey(privateKeyXml));
        RSAParameters actualPublic = rsa.ExportParameters(includePrivateParameters: false);
        RSAParameters expectedPublic = RsaXmlPublicKey.Parse(publicKeyXml);
        if (!CryptographicOperations.FixedTimeEquals(actualPublic.Modulus!, expectedPublic.Modulus!) ||
            !CryptographicOperations.FixedTimeEquals(actualPublic.Exponent!, expectedPublic.Exponent!))
        {
            throw new InvalidDataException("Private signing key does not match the pinned public key.");
        }

        string contentSha256 = CanonicalJson.Sha256Hex(content);
        var envelope = new JObject
        {
            ["schemaVersion"] = DetachedSignatureContract.SchemaVersion,
            ["app"] = DetachedSignatureContract.App,
            ["signedObject"] = DetachedSignatureContract.BridgeManifestSignedObject,
            ["algorithm"] = DetachedSignatureContract.Algorithm,
            ["keyId"] = keyId,
            ["publicKeyFingerprint"] = computedFingerprint,
            ["canonicalization"] = DetachedSignatureContract.Canonicalization,
            ["contentSha256"] = contentSha256,
            ["createdAtUtc"] = createdAtUtc.UtcDateTime.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
                System.Globalization.CultureInfo.InvariantCulture),
        };
        byte[] projectionBytes = CanonicalJson.SerializeUtf8(
            DetachedSignatureProjection.Create(envelope));
        envelope["signature"] = Convert.ToBase64String(rsa.SignData(
            projectionBytes,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1));

        return new BridgeUpdateSignature(
            envelope,
            DetachedSignatureContract.BridgeManifestSignedObject,
            keyId,
            contentSha256,
            computedFingerprint,
            CanonicalJson.Sha256Hex(projectionBytes));
    }

    public static void WriteEnvelopeAtomic(string outputPath, JObject envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        string target = Path.GetFullPath(outputPath);
        string? directory = Path.GetDirectoryName(target);
        if (directory is null || !Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException("Signer output directory must already exist.");
        }

        string temporary = Path.Combine(
            directory,
            "." + Path.GetFileName(target) + ".tmp-" + Guid.NewGuid().ToString("N"));
        byte[] bytes = Encoding.UTF8.GetBytes(CanonicalJson.Serialize(envelope) + "\n");
        try
        {
            using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporary, target, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    private static void ValidateManifest(JObject manifest)
    {
        if (manifest.Properties().Count() != ManifestFields.Count ||
            manifest.Properties().Any(property => !ManifestFields.Contains(property.Name)) ||
            manifest.Value<int?>("schemaVersion") != 1 ||
            manifest.Value<string>("channel") is not ("stable" or "pilot") ||
            !IsVersion(manifest.Value<string>("version")) ||
            manifest.Value<long?>("releaseSequence") is not > 0 ||
            manifest.Value<int?>("rolloutPercent") is not int rollout ||
            rollout is < 0 or > 100 ||
            !IsVersion(manifest.Value<string>("minSupportedVersion")) ||
            manifest.Value<string>("notes") is not string notes || notes.Length > 4096 ||
            manifest["components"] is not JArray components || components.Count != 2)
        {
            throw new InvalidDataException("Bridge update manifest shape is invalid.");
        }

        string[] names = components.Select(ValidateComponent).OrderBy(value => value, StringComparer.Ordinal).ToArray();
        if (!names.SequenceEqual(new[] { "addin", "bridge" }, StringComparer.Ordinal))
        {
            throw new InvalidDataException("Bridge update manifest requires exactly bridge and addin components.");
        }
    }

    private static string ValidateComponent(JToken token)
    {
        if (token is not JObject component ||
            component.Properties().Count() != ComponentFields.Count ||
            component.Properties().Any(property => !ComponentFields.Contains(property.Name)) ||
            component.Value<string>("name") is not string name ||
            name is not ("bridge" or "addin") ||
            !IsVersion(component.Value<string>("version")) ||
            component.Value<string>("sha256") is not string sha256 ||
            !System.Text.RegularExpressions.Regex.IsMatch(sha256, "^[0-9a-f]{64}$") ||
            component.Value<long?>("sizeBytes") is not > 0 ||
            component.Value<string>("url") is not string url ||
            !Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) ||
            uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new InvalidDataException("Bridge update component is invalid.");
        }

        return name;
    }

    private static bool IsIdentifier(string? value) =>
        value is not null && System.Text.RegularExpressions.Regex.IsMatch(
            value,
            "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$");

    private static bool IsVersion(string? value) =>
        value is not null && System.Text.RegularExpressions.Regex.IsMatch(
            value,
            "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$");

    private static RSAParameters ParsePrivateKey(string privateKeyXml)
    {
        if (string.IsNullOrWhiteSpace(privateKeyXml) || Encoding.UTF8.GetByteCount(privateKeyXml) > 64 * 1024)
        {
            throw new InvalidDataException("Private RSA key XML is absent or too large.");
        }

        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 64 * 1024,
        };
        XDocument document;
        using (var text = new StringReader(privateKeyXml))
        using (XmlReader reader = XmlReader.Create(text, settings))
        {
            document = XDocument.Load(reader, LoadOptions.None);
        }

        XElement root = document.Root ?? throw new InvalidDataException("Private RSA key XML has no root.");
        if (root.Name != "RSAKeyValue" || root.Attributes().Any() || document.Declaration is not null)
        {
            throw new InvalidDataException("Private RSA key XML root is invalid.");
        }

        string[] names = ["Modulus", "Exponent", "P", "Q", "DP", "DQ", "InverseQ", "D"];
        XElement[] elements = root.Elements().ToArray();
        if (elements.Length != names.Length || names.Any(name => elements.Count(element => element.Name == name) != 1) ||
            root.Nodes().Any(node => node is not XElement &&
                (node is not XText text || !string.IsNullOrWhiteSpace(text.Value))) ||
            elements.Any(element => element.Attributes().Any() ||
                element.Nodes().Any(node => node is not XText)))
        {
            throw new InvalidDataException("Private RSA key XML fields are invalid.");
        }

        byte[] Read(string name)
        {
            try
            {
                byte[] value = Convert.FromBase64String(elements.Single(element => element.Name == name).Value);
                return value.Length == 0
                    ? throw new InvalidDataException("Private RSA key XML contains an empty field.")
                    : value;
            }
            catch (FormatException exception)
            {
                throw new InvalidDataException("Private RSA key XML contains invalid base64.", exception);
            }
        }

        return new RSAParameters
        {
            Modulus = Read("Modulus"),
            Exponent = Read("Exponent"),
            P = Read("P"),
            Q = Read("Q"),
            DP = Read("DP"),
            DQ = Read("DQ"),
            InverseQ = Read("InverseQ"),
            D = Read("D"),
        };
    }
}

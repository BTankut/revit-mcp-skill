using Newtonsoft.Json.Linq;

namespace RevAgent.Bridge.ReleaseSigner;

internal static class Program
{
    private const int MaximumInputBytes = 1024 * 1024;

    public static int Main(string[] args)
    {
        try
        {
            IReadOnlyDictionary<string, string> options = ParseOptions(args);
            JObject content = JObject.Parse(ReadBounded(options, "content"));
            string privateKeyXml = ReadBounded(options, "private-key");
            JObject trustedKeys = JObject.Parse(ReadBounded(options, "trusted-keys"));
            DateTimeOffset createdAtUtc = DateTimeOffset.ParseExact(
                Required(options, "created-at-utc"),
                "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal |
                    System.Globalization.DateTimeStyles.AdjustToUniversal);
            BridgeUpdateSignature signature = BridgeUpdateReleaseSigner.Sign(
                content,
                Required(options, "key-id"),
                privateKeyXml,
                trustedKeys,
                createdAtUtc);
            BridgeUpdateReleaseSigner.WriteEnvelopeAtomic(
                Required(options, "envelope-out"),
                signature.Envelope);
            Console.WriteLine(JObject.FromObject(new
            {
                success = true,
                signedObject = signature.SignedObject,
                keyId = signature.KeyId,
                contentSha256 = signature.ContentSha256,
                publicKeyFingerprint = signature.PublicKeyFingerprint,
                canonicalProjectionSha256 = signature.CanonicalProjectionSha256,
            }).ToString(Newtonsoft.Json.Formatting.None));
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(JObject.FromObject(new
            {
                success = false,
                error = exception.GetType().Name,
                message = exception.Message,
            }).ToString(Newtonsoft.Json.Formatting.None));
            return 1;
        }
    }

    private static IReadOnlyDictionary<string, string> ParseOptions(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length || !args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Signer arguments must be --name value pairs.");
            }

            string name = args[index][2..];
            if (!result.TryAdd(name, args[index + 1]))
            {
                throw new ArgumentException($"Signer argument '--{name}' was repeated.");
            }
        }

        string[] allowed =
        [
            "content", "key-id", "private-key", "trusted-keys",
            "created-at-utc", "envelope-out",
        ];
        if (result.Keys.Any(key => !allowed.Contains(key, StringComparer.Ordinal)))
        {
            throw new ArgumentException("Signer received an unknown argument.");
        }

        return result;
    }

    private static string Required(IReadOnlyDictionary<string, string> options, string name)
    {
        if (!options.TryGetValue(name, out string? value) || string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"Signer argument '--{name}' is required.");
        }

        return value;
    }

    private static string ReadBounded(IReadOnlyDictionary<string, string> options, string name)
    {
        string path = Path.GetFullPath(Required(options, name));
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is < 1 or > MaximumInputBytes)
        {
            throw new InvalidDataException($"Signer input '{name}' is absent or exceeds its byte limit.");
        }

        return File.ReadAllText(path, new System.Text.UTF8Encoding(false, true));
    }
}

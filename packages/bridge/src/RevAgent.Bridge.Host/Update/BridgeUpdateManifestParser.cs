using System.Globalization;
using Newtonsoft.Json.Linq;

namespace RevAgent.Bridge.Host.Update;

internal static class BridgeUpdateManifestParser
{
    private static readonly HashSet<string> ExpectedFields = new(
        [
            "schemaVersion",
            "channel",
            "version",
            "releaseSequence",
            "components",
            "rolloutPercent",
            "minSupportedVersion",
            "notes",
        ],
        StringComparer.Ordinal);

    private static readonly HashSet<string> ComponentFields = new(
        ["name", "version", "sha256", "sizeBytes", "url"],
        StringComparer.Ordinal);

    internal static BridgeUpdateManifest Parse(JObject json)
    {
        ArgumentNullException.ThrowIfNull(json);
        RejectUnexpectedFields(json, ExpectedFields, "manifest");
        int schemaVersion = ReadInteger(json, "schemaVersion", 1, 1);
        string channel = ReadText(json, "channel", 64);
        string version = ReadText(json, "version", 128);
        UpdatePathPolicy.ValidateVersion(version);
        long releaseSequence = ReadLong(json, "releaseSequence", 1, long.MaxValue);
        int rolloutPercent = ReadInteger(json, "rolloutPercent", 0, 100);
        string minimumSupportedVersion = ReadText(
            json,
            "minSupportedVersion",
            128);
        UpdatePathPolicy.ValidateVersion(minimumSupportedVersion);
        string notes = ReadOptionalText(json, "notes", 4096);

        if (json["components"] is not JArray componentArray ||
            componentArray.Count != 2)
        {
            throw Reject(
                "invalid_components",
                "Manifest must contain exactly one Bridge and one add-in component.");
        }

        var components = new List<BridgeUpdateComponent>(componentArray.Count);
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (JToken token in componentArray)
        {
            if (token is not JObject component)
            {
                throw Reject("invalid_component", "Each manifest component must be an object.");
            }

            RejectUnexpectedFields(component, ComponentFields, "component");
            string name = ReadText(component, "name", 16);
            if (name is not ("bridge" or "addin") || !names.Add(name))
            {
                throw Reject(
                    "invalid_component_name",
                    "Component names must be unique and equal to 'bridge' or 'addin'.");
            }

            string componentVersion = ReadText(component, "version", 128);
            UpdatePathPolicy.ValidateVersion(componentVersion);
            if (!string.Equals(componentVersion, version, StringComparison.Ordinal))
            {
                throw Reject(
                    "component_version_mismatch",
                    "Every component version must match the manifest version.");
            }

            string sha256 = ReadText(component, "sha256", 64);
            if (sha256.Length != 64 || !sha256.All(Uri.IsHexDigit))
            {
                throw Reject("invalid_component_hash", "Component sha256 must be 64 hex characters.");
            }

            long sizeBytes = ReadLong(component, "sizeBytes", 1, 512L * 1024 * 1024);
            string urlText = ReadText(component, "url", 2048);
            if (!Uri.TryCreate(urlText, UriKind.Absolute, out Uri? url) ||
                !string.Equals(url.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                !string.IsNullOrEmpty(url.UserInfo) ||
                !string.IsNullOrEmpty(url.Fragment))
            {
                throw Reject(
                    "invalid_component_url",
                    "Component URL must be an absolute HTTPS URL without user-info or fragment.");
            }

            components.Add(new BridgeUpdateComponent(
                name,
                componentVersion,
                sha256.ToLowerInvariant(),
                sizeBytes,
                url));
        }

        if (!names.SetEquals(["bridge", "addin"]))
        {
            throw Reject(
                "invalid_components",
                "Manifest must contain exactly one Bridge and one add-in component.");
        }

        return new BridgeUpdateManifest(
            schemaVersion,
            channel,
            version,
            releaseSequence,
            components,
            rolloutPercent,
            minimumSupportedVersion,
            notes);
    }

    private static void RejectUnexpectedFields(
        JObject value,
        IReadOnlySet<string> expected,
        string kind)
    {
        foreach (JProperty property in value.Properties())
        {
            if (!expected.Contains(property.Name))
            {
                throw Reject(
                    "unexpected_manifest_field",
                    $"Update {kind} contains unexpected field '{property.Name}'.");
            }
        }
    }

    private static int ReadInteger(JObject value, string name, int minimum, int maximum)
    {
        long parsed = ReadLong(value, name, minimum, maximum);
        return checked((int)parsed);
    }

    private static long ReadLong(JObject value, string name, long minimum, long maximum)
    {
        JToken? token = value[name];
        if (token?.Type != JTokenType.Integer ||
            !long.TryParse(
                token.ToString(),
                NumberStyles.AllowLeadingSign,
                CultureInfo.InvariantCulture,
                out long parsed) ||
            parsed < minimum || parsed > maximum)
        {
            throw Reject(
                "invalid_manifest_number",
                $"Manifest field '{name}' is outside its accepted integer range.");
        }

        return parsed;
    }

    private static string ReadText(JObject value, string name, int maximumLength)
    {
        string text = value[name]?.Type == JTokenType.String
            ? value[name]!.Value<string>() ?? string.Empty
            : string.Empty;
        if (string.IsNullOrWhiteSpace(text) || text.Length > maximumLength ||
            text.Any(char.IsControl))
        {
            throw Reject("invalid_manifest_text", $"Manifest field '{name}' is invalid.");
        }

        return text;
    }

    private static string ReadOptionalText(JObject value, string name, int maximumLength)
    {
        JToken? token = value[name];
        if (token?.Type != JTokenType.String)
        {
            throw Reject("invalid_manifest_text", $"Manifest field '{name}' must be a string.");
        }

        string text = token.Value<string>() ?? string.Empty;
        if (text.Length > maximumLength || text.Any(ch => char.IsControl(ch) && ch is not '\r' and not '\n' and not '\t'))
        {
            throw Reject("invalid_manifest_text", $"Manifest field '{name}' is invalid.");
        }

        return text;
    }

    private static BridgeUpdateRejectedException Reject(string code, string message) =>
        new(code, message);
}

internal static class UpdatePathPolicy
{
    internal static void ValidateVersion(string version)
    {
        if (string.IsNullOrWhiteSpace(version) || version.Length > 128 ||
            version is "." or ".." ||
            version.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            version.Contains(Path.DirectorySeparatorChar) ||
            version.Contains(Path.AltDirectorySeparatorChar))
        {
            throw new BridgeUpdateRejectedException(
                "invalid_version",
                "Update version is not a safe directory name.");
        }
    }

    internal static string Descendant(string root, params string[] parts)
    {
        string fullRoot = Path.GetFullPath(root);
        string candidate = Path.GetFullPath(Path.Combine([fullRoot, .. parts]));
        string relative = Path.GetRelativePath(fullRoot, candidate);
        if (Path.IsPathFullyQualified(relative) || relative == ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new BridgeUpdateRejectedException(
                "path_escape",
                "Update path escaped its authorized root.");
        }

        return candidate;
    }
}

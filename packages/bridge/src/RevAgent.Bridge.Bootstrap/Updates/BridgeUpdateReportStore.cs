using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevAgent.Bridge.Bootstrap.Updates;

internal static class BridgeUpdateReportStates
{
    internal const string Staged = "staged";
    internal const string Applied = "applied";
    internal const string Deferred = "deferred";
    internal const string Refused = "refused";
    internal const string Rollback = "rollback";
    internal const string Quarantined = "quarantined";

    internal static bool IsKnown(string state) => state is
        Staged or Applied or Deferred or Refused or Rollback or Quarantined;
}

internal sealed record BridgeUpdateReport(
    string ReportId,
    string DeviceId,
    string FromVersion,
    string ToVersion,
    long ReleaseSequence,
    string ManifestDigest,
    string State,
    string Reason,
    string? Error,
    DateTimeOffset OccurredAtUtc);

internal sealed class BridgeUpdateReportStore
{
    internal const int MaximumPendingReports = 32;
    internal const int MaximumReportBytes = 16 * 1024;
    internal const int MaximumHeartbeatReports = 16;
    internal const int MaximumHeartbeatReportBytes = 64 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private readonly BridgeInstallLayout _layout;

    internal BridgeUpdateReportStore(BridgeInstallLayout layout)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
    }

    internal async Task<BridgeUpdateReport> AppendAsync(
        string deviceId,
        string fromVersion,
        string toVersion,
        long releaseSequence,
        string manifestDigest,
        string state,
        string reason,
        string? error,
        DateTimeOffset occurredAtUtc,
        CancellationToken cancellationToken)
    {
        ValidateText(deviceId, nameof(deviceId), 256, allowEmpty: false);
        ValidateText(fromVersion, nameof(fromVersion), 128, allowEmpty: true);
        ValidateText(toVersion, nameof(toVersion), 128, allowEmpty: true);
        ValidateText(reason, nameof(reason), 512, allowEmpty: false);
        if (error is not null)
        {
            ValidateText(error, nameof(error), 2048, allowEmpty: true);
        }

        if (releaseSequence < 0 || !BridgeUpdateReportStates.IsKnown(state) ||
            !IsDigest(manifestDigest))
        {
            throw new InvalidDataException("Bridge update report fields are invalid.");
        }

        Directory.CreateDirectory(_layout.UpdateReportPendingRoot);
        foreach (string existingPath in Directory.GetFiles(
                     _layout.UpdateReportPendingRoot,
                     "*.json",
                     SearchOption.TopDirectoryOnly))
        {
            BridgeUpdateReport existing = await ReadOneAsync(
                existingPath,
                cancellationToken).ConfigureAwait(false);
            if (existing.DeviceId == deviceId &&
                existing.FromVersion == fromVersion &&
                existing.ToVersion == toVersion &&
                existing.ReleaseSequence == releaseSequence &&
                existing.ManifestDigest == manifestDigest &&
                existing.State == state && existing.Reason == reason &&
                existing.Error == error)
            {
                return existing;
            }
        }

        DateTimeOffset normalizedOccurredAt = occurredAtUtc.ToUniversalTime();
        string reportId = DeterministicReportId(
            deviceId,
            fromVersion,
            toVersion,
            releaseSequence,
            manifestDigest,
            state,
            reason,
            normalizedOccurredAt.UtcTicks);
        var report = new BridgeUpdateReport(
            reportId,
            deviceId,
            fromVersion,
            toVersion,
            releaseSequence,
            manifestDigest,
            state,
            reason,
            error,
            normalizedOccurredAt);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(report, JsonOptions);
        if (bytes.Length > MaximumReportBytes)
        {
            throw new InvalidDataException("Bridge update report exceeds its byte limit.");
        }

        string target = ReportPath(reportId);
        if (!File.Exists(target) && Directory.GetFiles(
                _layout.UpdateReportPendingRoot,
                "*.json",
                SearchOption.TopDirectoryOnly).Length >= MaximumPendingReports)
        {
            throw new InvalidDataException(
                "Pending update report count reached its fail-closed limit.");
        }
        string temporary = target + $".tmp-{Guid.NewGuid():N}";
        await using (FileStream stream = new(
            temporary,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough))
        {
            await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }

        try
        {
            File.Move(temporary, target);
        }
        catch (IOException) when (File.Exists(target))
        {
            File.Delete(temporary);
            BridgeUpdateReport existing = await ReadOneAsync(target, cancellationToken)
                .ConfigureAwait(false);
            if (existing != report with { OccurredAtUtc = existing.OccurredAtUtc })
            {
                throw new InvalidDataException(
                    "Deterministic update report id is bound to different content.");
            }

            return existing;
        }

        return report;
    }

    internal async Task<IReadOnlyList<BridgeUpdateReport>> ReadPendingAsync(
        CancellationToken cancellationToken)
    {
        if (!Directory.Exists(_layout.UpdateReportPendingRoot))
        {
            return [];
        }

        string[] files = Directory.GetFiles(
            _layout.UpdateReportPendingRoot,
            "*.json",
            SearchOption.TopDirectoryOnly);
        if (files.Length > MaximumPendingReports)
        {
            throw new InvalidDataException("Pending update report count exceeds its limit.");
        }

        var reports = new List<BridgeUpdateReport>(files.Length);
        foreach (string path in files.OrderBy(value => value, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            reports.Add(await ReadOneAsync(path, cancellationToken).ConfigureAwait(false));
        }

        return reports;
    }

    internal void Acknowledge(IEnumerable<string> reportIds)
    {
        ArgumentNullException.ThrowIfNull(reportIds);
        foreach (string reportId in reportIds.Distinct(StringComparer.Ordinal))
        {
            if (!Guid.TryParseExact(reportId, "D", out _))
            {
                throw new InvalidDataException("Update report acknowledgement id is invalid.");
            }

            string path = ReportPath(reportId);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }

    private async Task<BridgeUpdateReport> ReadOneAsync(
        string path,
        CancellationToken cancellationToken)
    {
        FileInfo info = new(path);
        if (!info.Exists || info.Length <= 0 || info.Length > MaximumReportBytes ||
            (info.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("Pending update report file is invalid.");
        }

        byte[] bytes = await File.ReadAllBytesAsync(path, cancellationToken)
            .ConfigureAwait(false);
        BridgeUpdateReport report = JsonSerializer.Deserialize<BridgeUpdateReport>(
            bytes,
            JsonOptions) ?? throw new InvalidDataException("Pending update report is empty.");
        ValidateText(report.DeviceId, nameof(report.DeviceId), 256, allowEmpty: false);
        ValidateText(report.FromVersion, nameof(report.FromVersion), 128, allowEmpty: true);
        ValidateText(report.ToVersion, nameof(report.ToVersion), 128, allowEmpty: true);
        ValidateText(report.Reason, nameof(report.Reason), 512, allowEmpty: false);
        if (report.Error is not null)
        {
            ValidateText(report.Error, nameof(report.Error), 2048, allowEmpty: true);
        }

        string expectedId = DeterministicReportId(
            report.DeviceId,
            report.FromVersion,
            report.ToVersion,
            report.ReleaseSequence,
            report.ManifestDigest,
            report.State,
            report.Reason,
            report.OccurredAtUtc.ToUniversalTime().UtcTicks);
        if (!string.Equals(
                Path.GetFileNameWithoutExtension(path),
                report.ReportId,
                StringComparison.Ordinal) ||
            !string.Equals(report.ReportId, expectedId, StringComparison.Ordinal) ||
            !Guid.TryParseExact(report.ReportId, "D", out _) ||
            report.ReleaseSequence < 0 ||
            !BridgeUpdateReportStates.IsKnown(report.State) ||
            !IsDigest(report.ManifestDigest))
        {
            throw new InvalidDataException("Pending update report content is invalid.");
        }

        return report;
    }

    private string ReportPath(string reportId) =>
        Path.Combine(_layout.UpdateReportPendingRoot, reportId + ".json");

    private static string DeterministicReportId(params object[] parts)
    {
        string material = string.Join("\0", parts.Select(
            value => Convert.ToString(
                value,
                System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty));
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        Span<byte> id = digest.AsSpan(0, 16);
        id[6] = (byte)((id[6] & 0x0F) | 0x50);
        id[8] = (byte)((id[8] & 0x3F) | 0x80);
        return new Guid(id, bigEndian: true).ToString("D");
    }

    private static bool IsDigest(string value) =>
        value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) &&
        value.AsSpan(7).ToArray().All(Uri.IsHexDigit);

    private static void ValidateText(
        string value,
        string name,
        int maximumLength,
        bool allowEmpty)
    {
        if ((!allowEmpty && string.IsNullOrWhiteSpace(value)) ||
            value.Length > maximumLength || value.Any(char.IsControl))
        {
            throw new InvalidDataException($"Bridge update report field '{name}' is invalid.");
        }
    }
}

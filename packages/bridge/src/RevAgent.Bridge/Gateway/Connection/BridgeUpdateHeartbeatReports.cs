using System.Globalization;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Updates;

namespace RevAgent.Bridge.Gateway.Connection;

internal static class BridgeUpdateHeartbeatReports
{
    internal static object[] ToWireRows(
        IReadOnlyList<BridgeUpdateReport> updateReports) =>
        updateReports.Select(report => (object)new Dictionary<string, object?>
        {
            ["report_id"] = report.ReportId,
            ["device_id"] = report.DeviceId,
            ["from_version"] = report.FromVersion,
            ["to_version"] = report.ToVersion,
            ["release_sequence"] = report.ReleaseSequence,
            ["manifest_digest"] = report.ManifestDigest,
            ["state"] = report.State,
            ["reason"] = report.Reason,
            ["error"] = report.Error,
            ["occurred_at"] = report.OccurredAtUtc.ToString(
                "O",
                CultureInfo.InvariantCulture),
        }).ToArray();

    internal static IReadOnlyList<BridgeUpdateReport> Bound(
        IReadOnlyList<BridgeUpdateReport> reports)
    {
        var bounded = new List<BridgeUpdateReport>(
            Math.Min(reports.Count, BridgeUpdateReportStore.MaximumHeartbeatReports));
        int bytes = 0;
        foreach (BridgeUpdateReport report in reports.Take(
                     BridgeUpdateReportStore.MaximumHeartbeatReports))
        {
            int reportBytes = JsonSerializer.SerializeToUtf8Bytes(report).Length;
            if (bytes + reportBytes >
                BridgeUpdateReportStore.MaximumHeartbeatReportBytes)
            {
                break;
            }

            bytes += reportBytes;
            bounded.Add(report);
        }

        return bounded;
    }

    internal static void Acknowledge(
        BridgeUpdateReportStore store,
        IReadOnlyList<string> sentReportIds,
        IReadOnlyList<string> acknowledgedReportIds)
    {
        ArgumentNullException.ThrowIfNull(store);
        if (acknowledgedReportIds.Any(
                reportId => !sentReportIds.Contains(
                    reportId,
                    StringComparer.Ordinal)))
        {
            throw new InvalidDataException(
                "Gateway acknowledged an update report outside the current heartbeat flight.");
        }

        store.Acknowledge(acknowledgedReportIds);
    }
}

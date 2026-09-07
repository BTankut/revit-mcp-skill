using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Updates;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private RbpEnvelope CreateControlEnvelope(
        string type,
        JsonElement payload) =>
        new(
            Version: 1,
            type,
            _identifiers.NewId(),
            _clock.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            payload.Clone(),
            RbpEnvelopeScope.Control,
            Rsid: null,
            Sequence: null,
            Acknowledgement: null,
            Hello: null,
            HelloAck: null,
            RbpEnvelopeDisposition.Known,
            RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>(
                    StringComparer.Ordinal)));

    private RbpEnvelope CreateDataEnvelope(
        RbpDataEnvelopeSnapshot snapshot) =>
        new(
            snapshot.Version,
            snapshot.Type,
            snapshot.Id,
            snapshot.Timestamp ??
            _clock.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            snapshot.Payload.Clone(),
            RbpEnvelopeScope.Data,
            snapshot.Rsid,
            snapshot.Sequence,
            snapshot.Acknowledgement,
            Hello: null,
            HelloAck: null,
            RbpEnvelopeDisposition.Known,
            RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>(
                    StringComparer.Ordinal)));

    private JsonElement CreateHeartbeatPayload(
        IReadOnlyList<BoundSession> sessions,
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements,
        IReadOnlyList<BridgeUpdateReport> updateReports)
    {
        object[] ackRows = acknowledgements
            .OrderBy(item => item.Rsid, StringComparer.Ordinal)
            .Select(item => (object)new Dictionary<string, object?>
            {
                ["rsid"] = item.Rsid,
                ["seq"] = item.Sequence,
            })
            .ToArray();
        object[] sessionRows = sessions
            .Where(item => item.Lifecycle.DispatchAllowed)
            .OrderBy(item => item.Stored.Rsid, StringComparer.Ordinal)
            .Select(item => (object)new Dictionary<string, object?>
            {
                ["rsid"] = item.Stored.Rsid,
                ["port"] = item.Local.Port,
                ["revit_status"] = item.Local.RevitStatus,
            })
            .ToArray();
        object[] updateRows = BridgeUpdateHeartbeatReports.ToWireRows(updateReports);
        var payload = new Dictionary<string, object?>
        {
            ["bridge_version"] = _options.HelloProfile.BridgeVersion,
            ["acks"] = ackRows,
            ["sessions"] = sessionRows,
        };
        if (updateRows.Length > 0)
        {
            payload["update_reports"] = updateRows;
        }

        return JsonSerializer.SerializeToElement(payload);
    }

    private static IReadOnlyList<string> ParseUpdateReportAcknowledgements(
        RbpEnvelope envelope)
    {
        if (!envelope.Payload.TryGetProperty(
                "update_report_acks",
                out JsonElement values))
        {
            return [];
        }

        if (values.ValueKind != JsonValueKind.Array ||
            values.GetArrayLength() > BridgeUpdateReportStore.MaximumHeartbeatReports)
        {
            throw InvalidControl(
                "heartbeat_ack update_report_acks must be a bounded array.");
        }

        var reportIds = new List<string>(values.GetArrayLength());
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement value in values.EnumerateArray())
        {
            string reportId = value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? string.Empty
                : string.Empty;
            if (!Guid.TryParseExact(reportId, "D", out _) || !seen.Add(reportId))
            {
                throw InvalidControl(
                    "heartbeat_ack update report ids must be unique UUIDs.");
            }

            reportIds.Add(reportId);
        }

        return reportIds;
    }

    private static IReadOnlyList<RbpSessionAcknowledgement>
        ParseHeartbeatAcknowledgements(RbpEnvelope envelope)
    {
        _ = RequiredTimestamp(
            envelope.Payload,
            "server_time");
        JsonElement values = RequiredArray(envelope.Payload, "acks");
        var acknowledgements = new List<RbpSessionAcknowledgement>();
        var rsids = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.Object)
            {
                throw InvalidControl("heartbeat_ack acks must be objects.");
            }

            string rsid = RequiredString(value, "rsid", 256);
            long sequence = RequiredSafeInteger(value, "seq", allowZero: true);
            if (!rsids.Add(rsid))
            {
                throw InvalidControl(
                    "heartbeat_ack acks must have unique rsids.");
            }

            acknowledgements.Add(
                new RbpSessionAcknowledgement(rsid, sequence));
        }

        return Array.AsReadOnly(acknowledgements.ToArray());
    }

    private static RbpSessionRegistered ParseSessionRegistered(
        RbpEnvelope envelope)
    {
        if (!string.Equals(
                envelope.Type,
                "session_registered",
                StringComparison.Ordinal))
        {
            throw InvalidControl("Expected session_registered.");
        }

        string rsid = RequiredString(envelope.Payload, "rsid", 256);
        string resumeToken = RequiredString(
            envelope.Payload,
            "resume_token",
            4096);
        DateTimeOffset expires = RequiredTimestamp(
            envelope.Payload,
            "resume_expires_at");
        JsonElement capabilities = RequiredArray(
            envelope.Payload,
            "granted_session_capabilities");
        var granted = new List<string>();
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement value in capabilities.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String)
            {
                throw InvalidControl(
                    "Granted session capabilities must be strings.");
            }

            string capability = value.GetString() ?? string.Empty;
            if (!CapabilityPattern.IsMatch(capability) ||
                !unique.Add(capability))
            {
                throw InvalidControl(
                    "Granted session capabilities must be bounded and unique.");
            }

            granted.Add(capability);
        }

        JsonElement principal = RequiredObject(envelope.Payload, "principal");
        _ = RequiredString(principal, "tenant_id", 256);
        _ = RequiredString(principal, "user_id", 256);
        JsonElement seat = RequiredObject(envelope.Payload, "seat");
        if (!seat.TryGetProperty("granted", out JsonElement grantedSeat) ||
            grantedSeat.ValueKind is not (
                JsonValueKind.True or JsonValueKind.False) ||
            !grantedSeat.GetBoolean())
        {
            throw InvalidControl(
                "session_registered requires a granted seat.");
        }

        _ = RequiredString(seat, "seat_id", 256);
        return new RbpSessionRegistered(
            rsid,
            resumeToken,
            expires,
            Array.AsReadOnly(granted.ToArray()));
    }

    private static void ValidateGrantedSessionCapabilities(
        JsonElement registrationPayload,
        IReadOnlyList<string> granted)
    {
        JsonElement offeredValues = RequiredArray(
            registrationPayload,
            "session_capabilities");
        var offered = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement value in offeredValues.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String ||
                !offered.Add(value.GetString() ?? string.Empty))
            {
                throw InvalidCatalog();
            }
        }

        if (granted.Any(capability => !offered.Contains(capability)))
        {
            throw InvalidControl(
                "session_registered granted an unoffered session " +
                "capability.");
        }
    }

    private static RbpResumeAck ParseResumeAck(
        RbpEnvelope envelope,
        string expectedRsid)
    {
        if (!string.Equals(
                envelope.Type,
                "resume_ack",
                StringComparison.Ordinal))
        {
            throw InvalidControl("Expected resume_ack.");
        }

        string rsid = RequiredString(envelope.Payload, "rsid", 256);
        if (!string.Equals(rsid, expectedRsid, StringComparison.Ordinal))
        {
            throw InvalidControl(
                "resume_ack does not match the requested rsid.");
        }

        return new RbpResumeAck(
            rsid,
            RequiredSafeInteger(
                envelope.Payload,
                "last_rx_seq",
                allowZero: true),
            RequiredTimestamp(envelope.Payload, "resume_expires_at"));
    }

    private static RbpGoodbyeCycleException ParseGoodbye(
        RbpEnvelope envelope,
        double continuousSteadyMilliseconds)
    {
        string reason = RequiredString(envelope.Payload, "reason", 64);
        RbpGoodbyeReason parsed = reason switch
        {
            "shutdown" => RbpGoodbyeReason.Shutdown,
            "update" => RbpGoodbyeReason.Update,
            "server_draining" => RbpGoodbyeReason.ServerDraining,
            "protocol_error" => RbpGoodbyeReason.ProtocolError,
            "auth_revoked" => RbpGoodbyeReason.AuthRevoked,
            _ => throw InvalidControl("Unknown goodbye reason."),
        };
        long retryAfter = 0;
        if (envelope.Payload.TryGetProperty(
                "retry_after_ms",
                out JsonElement retryValue))
        {
            retryAfter = ReadSafeInteger(
                retryValue,
                "retry_after_ms",
                allowZero: true);
            if (parsed is not (
                    RbpGoodbyeReason.Update or
                    RbpGoodbyeReason.ServerDraining))
            {
                throw InvalidControl(
                    "retry_after_ms is invalid for this goodbye reason.");
            }
        }

        return new RbpGoodbyeCycleException(
            parsed,
            retryAfter,
            continuousSteadyMilliseconds);
    }

    private static IReadOnlyList<RbpLocalSessionSnapshot>
        ValidateCatalogSnapshot(
            IReadOnlyList<RbpLocalSessionSnapshot> snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var localKeys = new HashSet<string>(StringComparer.Ordinal);
        var ports = new HashSet<int>();
        var result = new List<RbpLocalSessionSnapshot>(snapshot.Count);
        foreach (RbpLocalSessionSnapshot? item in snapshot)
        {
            if (item is null ||
                string.IsNullOrWhiteSpace(item.LocalSessionKey) ||
                item.LocalSessionKey.Length > 512 ||
                item.Port is < 1 or > 65_535 ||
                item.RegistrationPayload.ValueKind != JsonValueKind.Object ||
                item.RevitStatus.ValueKind != JsonValueKind.Object)
            {
                throw InvalidCatalog();
            }

            string payloadKey = RequiredString(
                item.RegistrationPayload,
                "local_session_key",
                512);
            long payloadPort = RequiredSafeInteger(
                item.RegistrationPayload,
                "port",
                allowZero: false);
            if (!string.Equals(
                    payloadKey,
                    item.LocalSessionKey,
                    StringComparison.Ordinal) ||
                payloadPort != item.Port ||
                !localKeys.Add(item.LocalSessionKey) ||
                !ports.Add(item.Port))
            {
                throw InvalidCatalog();
            }

            if (!item.RevitStatus.TryGetProperty(
                    "addin_reachable",
                    out JsonElement reachable) ||
                reachable.ValueKind is not (
                    JsonValueKind.True or JsonValueKind.False) ||
                !item.RevitStatus.TryGetProperty("active_task", out _))
            {
                throw InvalidCatalog();
            }

            try
            {
                ValidateRegistrationPayload(item.RegistrationPayload);
            }
            catch (RbpCoordinatorException)
            {
                throw InvalidCatalog();
            }

            _ = RbpJournalSerialization.CanonicalRegistration(
                item.RegistrationPayload);
            result.Add(
                item with
                {
                    RegistrationPayload =
                        item.RegistrationPayload.Clone(),
                    RevitStatus = item.RevitStatus.Clone(),
                });
        }

        return new ReadOnlyCollection<RbpLocalSessionSnapshot>(
            result
                .OrderBy(item => item.Port)
                .ThenBy(item => item.LocalSessionKey, StringComparer.Ordinal)
                .ToArray());
    }

    private static bool RegistrationMatches(
        RbpStoredSession stored,
        RbpLocalSessionSnapshot local)
    {
        (_, string digest) =
            RbpJournalSerialization.CanonicalRegistration(
                local.RegistrationPayload);
        return string.Equals(
            stored.RegistrationDigest,
            digest,
            StringComparison.Ordinal);
    }

    private static void ValidateRegistrationPayload(JsonElement payload)
    {
        foreach (string authorityName in new[]
                 {
                     "tenant_id",
                     "user_id",
                     "seat_id",
                     "principal",
                     "seat",
                 })
        {
            if (payload.TryGetProperty(authorityName, out _))
            {
                throw InvalidCatalog();
            }
        }

        JsonElement userHint = RequiredObject(payload, "user_hint");
        _ = RequiredBoundedString(
            userHint,
            "name",
            maximumLength: 4096,
            allowEmpty: true);
        JsonElement machine = RequiredObject(payload, "machine");
        _ = RequiredBoundedString(
            machine,
            "hostname",
            maximumLength: 4096,
            allowEmpty: false);
        string fingerprint = RequiredBoundedString(
            machine,
            "fingerprint",
            maximumLength: 71,
            allowEmpty: false);
        if (!Sha256Pattern.IsMatch(fingerprint))
        {
            throw InvalidCatalog();
        }

        JsonElement revit = RequiredObject(payload, "revit");
        _ = RequiredBoundedString(
            revit,
            "version",
            maximumLength: 128,
            allowEmpty: false);
        _ = RequiredBoundedString(
            revit,
            "build",
            maximumLength: 128,
            allowEmpty: false);
        long processId = RequiredSafeInteger(
            revit,
            "pid",
            allowZero: false);
        if (processId > int.MaxValue)
        {
            throw InvalidCatalog();
        }

        _ = RequiredBoundedString(
            payload,
            "addin_version",
            maximumLength: 128,
            allowEmpty: false);
        _ = RequiredSafeInteger(
            payload,
            "result_contract_version",
            allowZero: false);
        _ = RequiredBoundedString(
            payload,
            "bridge_version",
            maximumLength: 128,
            allowEmpty: false);
        ValidateSessionCapabilities(
            RequiredArray(payload, "session_capabilities"));
        ValidateRegistrationDocuments(
            RequiredArray(payload, "documents"));
    }

    private static void ValidateSessionCapabilities(JsonElement values)
    {
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String)
            {
                throw InvalidCatalog();
            }

            string capability = value.GetString() ?? string.Empty;
            if (!CapabilityPattern.IsMatch(capability) ||
                !unique.Add(capability))
            {
                throw InvalidCatalog();
            }
        }
    }

    private static void ValidateRegistrationDocuments(JsonElement values)
    {
        int activeDocuments = 0;
        foreach (JsonElement document in values.EnumerateArray())
        {
            if (document.ValueKind != JsonValueKind.Object)
            {
                throw InvalidCatalog();
            }

            _ = RequiredBoundedString(
                document,
                "document_id",
                maximumLength: 4096,
                allowEmpty: false);
            _ = RequiredBoundedString(
                document,
                "title",
                maximumLength: 4096,
                allowEmpty: true);
            if (!document.TryGetProperty(
                    "path_digest",
                    out JsonElement pathDigest) ||
                pathDigest.ValueKind is not (
                    JsonValueKind.Null or JsonValueKind.String) ||
                (pathDigest.ValueKind == JsonValueKind.String &&
                 !Sha256Pattern.IsMatch(
                     pathDigest.GetString() ?? string.Empty)))
            {
                throw InvalidCatalog();
            }

            _ = RequiredBoolean(document, "is_workshared");
            if (RequiredBoolean(document, "is_active"))
            {
                activeDocuments++;
            }
        }

        if (activeDocuments > 1)
        {
            throw InvalidCatalog();
        }
    }

    private static RbpSessionLifecycleState
        CreateDisconnectedSessionLifecycle(RbpStoredSession session)
    {
        RbpSessionLifecycleState lifecycle =
            RbpConnectionReducer.CreateSessionLifecycle(
                session.LocalSessionKey);
        lifecycle = AdvanceSession(
            lifecycle,
            new RbpSessionEvent(RbpSessionEventType.RegisterRequested));
        lifecycle = AdvanceSession(
            lifecycle,
            new RbpSessionEvent(
                RbpSessionEventType.Registered,
                Rsid: session.Rsid));
        return AdvanceSession(
            lifecycle,
            new RbpSessionEvent(RbpSessionEventType.ConnectionLost));
    }

}

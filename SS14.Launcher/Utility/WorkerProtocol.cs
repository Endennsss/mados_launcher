using System.Text.Json;

namespace SS14.Launcher.Utility;

public static class WorkerProtocol
{
    public const int CurrentVersion = 1;

    public static bool IsSupportedVersion(int version) => version == CurrentVersion;

    public static string? ValidateRequest(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
            return "INVALID_REQUEST";
        if (!root.TryGetProperty("v", out var version)
            || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var versionValue)
            || !IsSupportedVersion(versionValue))
            return "UNSUPPORTED_VERSION";
        if (!root.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(id.GetString()))
            return "INVALID_REQUEST";
        if (!root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(method.GetString()))
            return "INVALID_REQUEST";
        return null;
    }

    public static string? TryGetRequestId(JsonElement root)
        => root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("id", out var id)
            && id.ValueKind == JsonValueKind.String
            ? id.GetString()
            : null;
}

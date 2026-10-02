using System;
using System.IO;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Serilog;
using Splat;
using SS14.Launcher.Api;
using SS14.Launcher.Localization;
using SS14.Launcher.Models;
using SS14.Launcher.Models.ContentManagement;
using SS14.Launcher.Models.Data;
using SS14.Launcher.Models.EngineManager;
using SS14.Launcher.Models.Logins;
using SS14.Launcher.Models.OverrideAssets;
using SS14.Launcher.Models.ServerStatus;
using SS14.Launcher.Worker;

namespace SS14.Launcher;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        // stdout belongs exclusively to the versioned protocol, including before
        // initialization. Libraries and diagnostics must never corrupt that stream.
        var protocol = Console.Out;
        Console.SetOut(TextWriter.Null);
        Log.Logger = new LoggerConfiguration().MinimumLevel.Debug()
            .WriteTo.Console(standardErrorFromLevel: Serilog.Events.LogEventLevel.Verbose).CreateLogger();
        DataManager? data = null;
        try
        {
            DataMigration.Prepare();
            LauncherPaths.CreateDirs();
            data = new DataManager();
            data.Load();
            Log.Logger = new LoggerConfiguration()
                .MinimumLevel.Is(data.GetCVar(CVars.LogLauncherVerbose) ? Serilog.Events.LogEventLevel.Verbose : Serilog.Events.LogEventLevel.Debug)
                .WriteTo.Console(standardErrorFromLevel: Serilog.Events.LogEventLevel.Verbose)
                .WriteTo.File(LauncherPaths.PathLauncherLog, rollingInterval: RollingInterval.Day, retainedFileCountLimit: 7)
                .CreateLogger();
            RegisterServices(data);
            LauncherDiagnostics.LogDiagnostics();
            await WorkerHost.RunAsync(protocol);
            return 0;
        }
        catch (Exception error)
        {
            Log.Error(error, "Worker startup failed");
            await protocol.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(new
            {
                v = 1, @event = "app.error", data = new
                {
                    code = error is MigrationException ? "MIGRATION_FAILED" : "INITIALIZATION_FAILED",
                    message = error is MigrationException ? error.Message : "Mados worker could not start. Open the launcher log for details."
                }
            }));
            await protocol.FlushAsync();
            return 1;
        }
        finally
        {
            data?.Close();
            Log.CloseAndFlush();
        }
    }

    private static void RegisterServices(DataManager data)
    {
        var locator = Locator.CurrentMutable;
        locator.RegisterConstant(data);
        var http = HappyEyeballsHttp.CreateHttpClient();
        http.Timeout = TimeSpan.FromSeconds(25);
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Mados.Launcher", LauncherVersion.Version?.ToString()));
        http.DefaultRequestHeaders.Add("SS14-Launcher-Fingerprint", data.Fingerprint.ToString());
        locator.RegisterConstant(http);
        var localization = new LocalizationManager(data);
        localization.Initialize();
        locator.RegisterConstant(localization);
        var auth = new AuthApi(http);
        var info = new LauncherInfoManager(http);
        locator.RegisterConstant(auth);
        locator.RegisterConstant(new HubApi(http));
        locator.RegisterConstant(info);
        locator.RegisterConstant(new LoginManager(data, auth));
        var engineManager = new EngineManagerDynamic();
        locator.RegisterConstant<IEngineManager>(engineManager);
        if ((Architecture)data.GetCVar(CVars.CurrentArchitecture) != RuntimeInformation.ProcessArchitecture)
        {
            engineManager.ClearAllEngines();
            data.SetCVar(CVars.CurrentArchitecture, (int)RuntimeInformation.ProcessArchitecture);
            data.CommitConfig();
        }
        locator.RegisterConstant(new ContentManager());
        locator.RegisterConstant(new Updater());
        locator.RegisterConstant(new OverrideAssetsManager(data, http, info));
        locator.RegisterConstant(new ServerListCache());
    }
}

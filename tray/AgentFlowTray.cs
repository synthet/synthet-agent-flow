// Windows tray app for the agent-flow dashboard: no console and no main window.
// scripts/build-tray.ps1 compiles it with the csc.exe in .NET Framework, which supports C# 5 only.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class AgentFlowTray
{
    const string AppName = "Agent Flow";
    const string DashboardUrl = "http://127.0.0.1:8791/";
    const string BoardUrl = "http://127.0.0.1:8791/api/board";
    const string ServeArgs = "bin\\agent-flow.js serve --port 8791 --exit-on-stdin-close";
    const string MutexName = @"Local\AgentFlowTray";
    const string QuitEventName = @"Local\AgentFlowTrayQuit";
    const int MaxLogBytes = 1000000;
    const int ShutdownTimeoutMs = 5000;
    // The first serve after a rebuild can take 15-20 s on Windows, so --open waits well past that.
    const int StartTimeoutMs = 90000;

    // An agent session that starts the tray must not make the dashboard act as that agent.
    static readonly string[] AgentIdentityVars = { "AGENT_FLOW_ACTOR", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID" };

    static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName, "agent-flow-tray.log");
    static readonly object LogLock = new object();

    static StreamWriter log;
    static Process host;
    static NotifyIcon icon;
    static Control ui;
    static string lastError;
    static bool quitting;
    static int exitCode;

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool IsProcessDPIAware();

    [STAThread]
    static int Main(string[] args)
    {
        // Before any UI. Without it, Windows hands out a 16 px icon and stretches it, and the menu blurs on scaled displays.
        SetProcessDPIAware();
        if (Array.IndexOf(args, "--check") >= 0) return Check();
        if (Array.IndexOf(args, "--quit") >= 0)
        {
            using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName)) quit.Set();
            return 0;
        }

        bool first;
        using (new Mutex(true, MutexName, out first))
        {
            if (!first)
            {
                OpenDashboard();
                return 0;
            }
            try
            {
                return Run(Array.IndexOf(args, "--open") >= 0);
            }
            catch (Exception error)
            {
                Fail(AppName + " could not start.\n\n" + error.Message);
                return 1;
            }
        }
    }

    /// <summary>Startup checks with no UI, mutex or quit event, so a running tray is never touched.</summary>
    static int Check()
    {
        try
        {
            using (new Icon(IconPath(FindRoot()), SystemInformation.SmallIconSize)) { }
        }
        catch (Exception)
        {
            return 2;
        }
        return IsProcessDPIAware() ? 0 : 3;
    }

    /// <summary>The checkout holding bin\agent-flow.js: AGENT_FLOW_ROOT, else the folder above dist\.</summary>
    static string FindRoot()
    {
        string root = Environment.GetEnvironmentVariable("AGENT_FLOW_ROOT");
        if (string.IsNullOrEmpty(root)) root = Path.GetDirectoryName(Path.GetDirectoryName(Application.ExecutablePath));
        if (!File.Exists(Path.Combine(root, "bin", "agent-flow.js")))
            throw new FileNotFoundException("bin\\agent-flow.js was not found under " + root + ". Run run.cmd from the checkout.");
        return root;
    }

    static string IconPath(string root)
    {
        return Path.Combine(root, "assets", "tray", "agent-flow.ico");
    }

    static int Run(bool open)
    {
        string root = FindRoot();
        OpenLog();

        // Hidden control: a marshalling target for callbacks from other threads.
        ui = new Control();
        ui.CreateControl();
        IntPtr handle = ui.Handle;

        // The native Windows menu, as in the mailbox and AI Quotas trays. ContextMenuStrip draws its own,
        // which does not match Windows 11. The default item is drawn bold.
        var openItem = new MenuItem("Open dashboard", delegate { OpenDashboard(); });
        openItem.DefaultItem = true;
        var menu = new ContextMenu(new[] { openItem, new MenuItem("Quit", delegate { Quit(); }) });

        icon = new NotifyIcon
        {
            Icon = new Icon(IconPath(root), SystemInformation.SmallIconSize),
            Text = AppName,
            ContextMenu = menu,
        };
        icon.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) OpenDashboard();
        };

        if (DashboardAnswers())
        {
            // Something else serves the port, such as a serve started by hand. Use it, and leave it running on Quit.
            WriteLog("A dashboard already answers on " + DashboardUrl + "; using it and leaving it running.");
            icon.Text = AppName + " (dashboard started elsewhere)";
        }
        else
        {
            StartHost(root);
        }

        var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
        ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate
        {
            ui.BeginInvoke(new MethodInvoker(Quit));
        }, null, Timeout.Infinite, true);

        icon.Visible = true;
        if (open)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                if (WaitForDashboard()) ui.BeginInvoke(new MethodInvoker(OpenDashboard));
            });
        }
        Application.Run();
        icon.Dispose();
        return exitCode;
    }

    static void StartHost(string root)
    {
        var start = new ProcessStartInfo("node", ServeArgs)
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string name in AgentIdentityVars) start.EnvironmentVariables.Remove(name);

        host = new Process();
        host.StartInfo = start;
        host.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog(e.Data); };
        host.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            lastError = e.Data;
            WriteLog(e.Data);
        };
        host.EnableRaisingEvents = true;
        host.SynchronizingObject = ui;
        host.Exited += delegate { HostExited(); };
        host.Start();
        host.BeginOutputReadLine();
        host.BeginErrorReadLine();
        WriteLog("Started serve, PID " + host.Id + ", in " + root);
    }

    static bool DashboardAnswers()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(BoardUrl);
            request.Proxy = null;
            request.Timeout = 1500;
            request.KeepAlive = false;
            using (var response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch (Exception)
        {
            return false;
        }
    }

    static bool WaitForDashboard()
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < StartTimeoutMs)
        {
            if (DashboardAnswers()) return true;
            if (quitting || (host != null && host.HasExited)) return false;
            Thread.Sleep(300);
        }
        WriteLog("The dashboard did not answer within " + (StartTimeoutMs / 1000) + " s.");
        return false;
    }

    static void OpenDashboard()
    {
        Process.Start(DashboardUrl);
    }

    static void Quit()
    {
        if (quitting) return;
        quitting = true;
        if (host != null && !host.HasExited)
        {
            // Closing stdin is serve's signal to shut down (--exit-on-stdin-close).
            host.StandardInput.Close();
            if (!host.WaitForExit(ShutdownTimeoutMs))
            {
                WriteLog("serve did not stop within " + (ShutdownTimeoutMs / 1000) + " s; ending it.");
                host.Kill();
            }
        }
        WriteLog("Quit.");
        Application.Exit();
    }

    static void HostExited()
    {
        if (quitting) return;
        // WaitForExit with no timeout also drains the stderr reader, so lastError is complete.
        host.WaitForExit();
        icon.Visible = false;
        exitCode = 1;
        Fail("The dashboard stopped unexpectedly.\n\n" + lastError + "\n\nSee " + LogPath);
        Application.Exit();
    }

    static void Fail(string message)
    {
        WriteLog(message);
        MessageBox.Show(message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static void OpenLog()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
        var existing = new FileInfo(LogPath);
        bool rotate = existing.Exists && existing.Length > MaxLogBytes;
        if (rotate) File.Copy(LogPath, LogPath + ".1", true);
        var stream = new FileStream(LogPath, rotate ? FileMode.Create : FileMode.Append, FileAccess.Write, FileShare.Read);
        log = new StreamWriter(stream) { AutoFlush = true };
    }

    static void WriteLog(string line)
    {
        if (log == null || string.IsNullOrEmpty(line)) return;
        lock (LogLock) log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line);
    }
}

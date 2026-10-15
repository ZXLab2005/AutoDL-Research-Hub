using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("AutoDL Research Hub")]
[assembly: AssemblyDescription("Portable Windows Research Hub launcher")]
[assembly: AssemblyVersion("1.3.0.0")]

internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SystemInfo
    {
        public ushort Architecture; public ushort Reserved; public uint PageSize;
        public IntPtr MinimumAddress; public IntPtr MaximumAddress; public UIntPtr ActiveMask;
        public uint ProcessorCount; public uint ProcessorType; public uint AllocationGranularity;
        public ushort ProcessorLevel; public ushort ProcessorRevision;
    }
    [DllImport("kernel32.dll")] private static extern void GetNativeSystemInfo(out SystemInfo info);

    [STAThread]
    private static int Main(string[] args)
    {
        bool headless = Array.IndexOf(args, "--headless") >= 0;
        try
        {
            SystemInfo system; GetNativeSystemInfo(out system);
            if (Environment.OSVersion.Version.Major < 10 || system.Architecture != 9)
                throw new InvalidOperationException("此安装包仅支持 Windows 10/11 x64。ARM64 与 32 位 Windows 需要专用版本。");
            string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            PortableRunner runner = new PortableRunner(root);
            bool prepareOnly = false, offline = false;
            string proxy = "";
            foreach (string arg in args)
            {
                if (arg == "--headless") continue;
                if (arg == "--prepare-only") prepareOnly = true;
                else if (arg == "--offline") offline = true;
                else if (arg.StartsWith("--proxy=", StringComparison.Ordinal)) proxy = arg.Substring(8);
                else throw new ArgumentException("Unknown launcher option: " + arg);
            }
            if (headless) return runner.Run(prepareOnly, offline, proxy, null);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm(runner, prepareOnly, offline, proxy));
            return runner.LastExitCode;
        }
        catch (Exception error)
        {
            if (!headless) MessageBox.Show(error.Message, "AutoDL 研究台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

internal sealed class PortableRunner
{
    internal readonly string Root;
    internal readonly string LogFile;
    private Process child;
    private readonly object childLock = new object();
    internal int LastExitCode = 1;

    internal PortableRunner(string root)
    {
        Root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        if (Root.Length < 4 || Root.StartsWith("\\\\", StringComparison.Ordinal) || Root[1] != ':')
            throw new InvalidOperationException("请把完整应用文件夹解压到本地磁盘的可写子目录。");
        CheckManagedPath(Root);
        string runtime = Path.Combine(Root, "data", "bootstrap");
        CheckManagedPath(runtime); Directory.CreateDirectory(runtime);
        LogFile = Path.Combine(runtime, "launcher.log"); CheckManagedPath(LogFile);
    }

    private void CheckManagedPath(string value)
    {
        string full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        if (!full.Equals(Root, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Application files must stay in the extracted folder.");
        string ancestor = full;
        while (!String.IsNullOrEmpty(ancestor))
        {
            if ((File.Exists(ancestor) || Directory.Exists(ancestor)) && (File.GetAttributes(ancestor) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Application folders cannot contain junctions or symbolic links.");
            ancestor = Path.GetDirectoryName(ancestor);
        }
    }

    private static string Quote(string value)
    {
        if (value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            throw new ArgumentException("Invalid launcher argument.");
        return "\"" + value + "\"";
    }

    internal void Cancel()
    {
        lock (childLock)
        {
            if (child != null) { try { if (!child.HasExited) child.Kill(); } catch (InvalidOperationException) { } }
        }
    }

    internal int Run(bool prepareOnly, bool offline, string proxy, Action<string> update)
    {
        LastExitCode = 1;
        try
        {
            string script = Path.Combine(Root, "scripts", "Bootstrap-Hub.ps1");
            CheckManagedPath(script);
            if (!File.Exists(script)) throw new FileNotFoundException("请先解压完整应用文件夹，再启动 EXE。缺少 scripts\\Bootstrap-Hub.ps1。");
            string windows = Environment.GetEnvironmentVariable("SystemRoot");
            string powershell = Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(powershell)) throw new FileNotFoundException("Windows PowerShell 5.1 is required.");
            ProcessStartInfo info = new ProcessStartInfo(powershell);
            info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script) + " -Root " + Quote(Root);
            if (prepareOnly) info.Arguments += " -PrepareOnly";
            if (offline) info.Arguments += " -Offline";
            if (!String.IsNullOrWhiteSpace(proxy)) info.Arguments += " -ProxyUrl " + Quote(proxy.Trim());
            info.WorkingDirectory = Root; info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
            string originalProfile = Environment.GetEnvironmentVariable("USERPROFILE");
            string originalCodex = Environment.GetEnvironmentVariable("CODEX_HOME");
            if (String.IsNullOrEmpty(info.EnvironmentVariables["RESEARCH_HUB_ORIGINAL_USERPROFILE"]) && !String.IsNullOrEmpty(originalProfile))
                info.EnvironmentVariables["RESEARCH_HUB_ORIGINAL_USERPROFILE"] = originalProfile;
            if (String.IsNullOrEmpty(info.EnvironmentVariables["RESEARCH_HUB_ORIGINAL_CODEX_HOME"]) && !String.IsNullOrEmpty(originalCodex))
                info.EnvironmentVariables["RESEARCH_HUB_ORIGINAL_CODEX_HOME"] = originalCodex;
            string[,] directories = {
                { "TEMP", "data\\temp" }, { "TMP", "data\\temp" }, { "HOME", "data\\home" }, { "USERPROFILE", "data\\home" },
                { "APPDATA", "data\\appdata\\Roaming" }, { "LOCALAPPDATA", "data\\appdata\\Local" }, { "CODEX_HOME", "data\\codex" }
            };
            for (int i = 0; i < directories.GetLength(0); i++)
            {
                string directory = Path.Combine(Root, directories[i, 1]);
                CheckManagedPath(directory); Directory.CreateDirectory(directory);
                info.EnvironmentVariables[directories[i, 0]] = directory;
            }
            using (StreamWriter log = new StreamWriter(LogFile, false, new UTF8Encoding(false)))
            using (Process process = new Process())
            {
                object logLock = new object();
                log.AutoFlush = true;
                log.WriteLine("AutoDL portable launcher " + DateTimeOffset.Now.ToString("o"));
                DataReceivedEventHandler handler = delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    lock (logLock) log.WriteLine(e.Data);
                    if (update != null) update(e.Data);
                };
                process.StartInfo = info; process.OutputDataReceived += handler; process.ErrorDataReceived += handler;
                lock (childLock) { child = process; process.Start(); }
                process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
                LastExitCode = process.ExitCode;
                lock (childLock) child = null;
                log.WriteLine("Exit code: " + LastExitCode);
                return LastExitCode;
            }
        }
        catch (Exception error)
        {
            lock (childLock) child = null;
            try { File.AppendAllText(LogFile, error.Message + Environment.NewLine, Encoding.UTF8); } catch (IOException) { }
            if (update != null) update(error.Message);
            return 1;
        }
    }
}

internal sealed class LauncherForm : Form
{
    private readonly PortableRunner runner;
    private readonly bool prepareOnly, offline;
    private readonly Label status;
    private readonly ProgressBar progress;
    private readonly TextBox details, proxy;
    private readonly Button retry;
    private bool busy;

    internal LauncherForm(PortableRunner runner, bool prepareOnly, bool offline, string initialProxy)
    {
        this.runner = runner; this.prepareOnly = prepareOnly; this.offline = offline;
        Text = "AutoDL 研究台"; ClientSize = new Size(760, 510); MinimumSize = new Size(700, 490);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(12, 24, 38); ForeColor = Color.WhiteSmoke;
        Font = new Font("Microsoft YaHei UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
        Label title = new Label { Text = "AutoDL 研究台", Location = new Point(28, 22), AutoSize = true, Font = new Font(Font.FontFamily, 21, FontStyle.Bold) };
        Label subtitle = new Label { Text = "正在准备你的研究空间 · 已有组件会直接复用", Location = new Point(30, 65), AutoSize = true, ForeColor = Color.FromArgb(151, 182, 203) };
        status = new Label { Text = "检查本机环境…", Location = new Point(30, 110), Size = new Size(700, 30), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        progress = new ProgressBar { Location = new Point(30, 148), Size = new Size(700, 13), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        details = new TextBox { Location = new Point(30, 180), Size = new Size(700, 205), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(7, 17, 28), ForeColor = Color.FromArgb(169, 199, 212), BorderStyle = BorderStyle.FixedSingle, Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right, Font = new Font("Consolas", 9) };
        Label proxyLabel = new Label { Text = "下载代理（可留空）", Location = new Point(30, 406), AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left };
        proxy = new TextBox { Text = initialProxy, Location = new Point(190, 401), Size = new Size(350, 27), Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right };
        retry = new Button { Text = "重试", Location = new Point(552, 397), Size = new Size(86, 34), Enabled = false, Anchor = AnchorStyles.Bottom | AnchorStyles.Right, FlatStyle = FlatStyle.Flat };
        Button close = new Button { Text = "取消", Location = new Point(648, 397), Size = new Size(82, 34), Anchor = AnchorStyles.Bottom | AnchorStyles.Right, FlatStyle = FlatStyle.Flat };
        Label note = new Label { Text = "组件、下载缓存与日志保存在当前应用文件夹内；无需管理员安装。", Location = new Point(30, 456), Size = new Size(700, 32), ForeColor = Color.FromArgb(151, 182, 203), Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right };
        Controls.AddRange(new Control[] { title, subtitle, status, progress, details, proxyLabel, proxy, retry, close, note });
        retry.Click += delegate { BeginPrepare(); }; close.Click += delegate { runner.Cancel(); Close(); };
        FormClosing += delegate { if (busy) runner.Cancel(); };
        Shown += delegate { BeginPrepare(); };
    }

    private async void BeginPrepare()
    {
        if (busy) return;
        busy = true; retry.Enabled = false; proxy.Enabled = false; progress.Value = 0; details.Clear();
        string selectedProxy = proxy.Text;
        int result = await Task.Run(() => runner.Run(prepareOnly, offline, selectedProxy, UpdateLine));
        busy = false;
        if (IsDisposed) return;
        if (result == 0) { Close(); return; }
        status.Text = "准备未完成。可检查网络后重试，已准备好的组件会保留。";
        retry.Enabled = true; proxy.Enabled = true;
        AppendLine("日志：" + runner.LogFile);
    }

    private void UpdateLine(string line)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke((Action)delegate
            {
                if (IsDisposed) return;
                if (line.StartsWith("@@PROGRESS:", StringComparison.Ordinal))
                {
                    string[] parts = line.Split(new char[] { ':' }, 3);
                    int value;
                    if (parts.Length == 3 && Int32.TryParse(parts[1], out value))
                    { progress.Value = Math.Max(0, Math.Min(100, value)); status.Text = parts[2]; AppendLine(parts[2]); return; }
                }
                AppendLine(line);
            });
        }
        catch (InvalidOperationException) { }
    }

    private void AppendLine(string line)
    {
        if (details.TextLength > 45000) details.Text = details.Text.Substring(details.TextLength - 30000);
        details.AppendText(line + Environment.NewLine);
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

// A separate, non-activating Windows status window. It never modifies Codex,
// reads its UI tree, injects code, or sends input to another application.
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var root = Environment.GetEnvironmentVariable("CODEX_TOKEN_STRIP_DATA_DIR");
        if (String.IsNullOrEmpty(root)) root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexTokenStrip");
        root = Path.GetFullPath(root);
        try
        {
            Directory.CreateDirectory(root);
            var settings = Settings.Load(root);
            Metrics.Port = settings.Port;
            if (args.Length > 0 && args[0] == "--demo")
            {
                var demo = new Metrics { Available = true, TotalReady = true,
                    Money = "会话 ≈$1.28", Tokens = " · 2.4M tokens", Total = "总计 ≈$12.46",
                    Speed = "≈61.2 tok/s", Cache = "缓存命中 94.8%" };
                using (var image = Strip.Render(demo, 1.5f, false, false))
                    image.Save(args.Length > 1 ? args[1] : Path.Combine(root, "demo.png"), ImageFormat.Png);
                return;
            }
            if (args.Length > 0 && args[0] == "--stop")
            {
                if (!File.Exists(Path.Combine(root, "runtime.json"))) return;
                var runtime = Json.Parse(File.ReadAllText(Path.Combine(root, "runtime.json")));
                try
                {
                    using (var process = Process.GetProcessById((int)Json.Number(runtime, "pid").Value))
                        if (String.Equals(process.MainModule.FileName, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase))
                        { process.Kill(); process.WaitForExit(3000); }
                }
                catch (ArgumentException) { }
                return;
            }
            if (args.Length > 0 && args[0] == "--probe")
            {
                uint foregroundPid;
                Native.GetWindowThreadProcessId(Native.GetAncestor(Native.GetForegroundWindow(), 3), out foregroundPid);
                // --probe PID is a read-only diagnostic for a known Codex process.
                if (args.Length > 1) foregroundPid = UInt32.Parse(args[1], CultureInfo.InvariantCulture);
                var data = Metrics.Fetch((int)foregroundPid);
                using (var image = Strip.Render(data, 1f, false, false))
                    image.Save(Path.Combine(root, "preview.png"), ImageFormat.Png);
                File.WriteAllText(Path.Combine(root, "probe.json"), Json.Stringify(new {
                    available = data.Available, text = data.Line, items = 4,
                    threadId = data.ThreadId, bindingStatus = data.BindingStatus, totalReady = data.TotalReady,
                    contextIndicator = false, binaryBytes = new FileInfo(Application.ExecutablePath).Length,
                    foregroundPid = foregroundPid, foregroundImage = Native.ProcessImage(foregroundPid),
                    officialForeground = Native.IsOfficialCodex(foregroundPid)
                }), Encoding.UTF8);
                return;
            }
            bool created;
            using (var mutex = new Mutex(true, "Local\\CodexTokenStrip-" + settings.Port.ToString(CultureInfo.InvariantCulture), out created))
            {
                if (!created) return;
                try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
                catch (EntryPointNotFoundException) { Native.SetProcessDPIAware(); }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var strip = new Strip(root)) Application.Run(strip);
            }
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(root, "error.log"), DateTime.UtcNow.ToString("o") + "\n" + error, Encoding.UTF8);
            if (args.Length == 0) MessageBox.Show("Codex Token Strip 无法启动：\n" + error.Message + "\n\n详情：" + Path.Combine(root, "error.log"), "Codex Token Strip");
            Environment.ExitCode = 1;
        }
    }
}

internal static class Json
{
    internal static Dictionary<string, object> Parse(string value)
    { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(value); }
    internal static string Stringify(object value) { return new JavaScriptSerializer().Serialize(value); }
    internal static object Get(Dictionary<string, object> value, string key)
    { object result; return value != null && value.TryGetValue(key, out result) ? result : null; }
    internal static Dictionary<string, object> Map(Dictionary<string, object> value, string key)
    { return Get(value, key) as Dictionary<string, object>; }
    internal static double? Number(Dictionary<string, object> value, string key)
    {
        var found = Get(value, key);
        if (found == null) return null;
        double number;
        return Double.TryParse(Convert.ToString(found, CultureInfo.InvariantCulture), NumberStyles.Float,
            CultureInfo.InvariantCulture, out number) && !Double.IsInfinity(number) && !Double.IsNaN(number) ? number : (double?)null;
    }
}

internal sealed class Metrics
{
    internal bool Available, TotalReady;
    internal string Money = "会话 —", Total = "总计 …", Tokens = "", Speed = "— tok/s", Cache = "缓存命中 —";
    internal string ThreadId = "", BindingStatus = "unknown";
    internal string Details = "等待识别当前聊天及统计数据";
    internal string Line { get { return Money + Tokens + "   ·   " + Total + "   ·   " + Speed + "   ·   " + Cache; } }
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    internal static int Port = 23957;

    internal static string Get(string route)
    {
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port.ToString(Invariant) + "/" + route);
        request.Proxy = null;
        request.Timeout = 1800;
        request.ReadWriteTimeout = 1800;
        request.AllowAutoRedirect = false;
        request.KeepAlive = false;
        using (var response = request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return reader.ReadToEnd();
    }
    internal static Metrics Fetch(int processId)
    {
        var health = Json.Parse(Get("health"));
        if (!Object.Equals(Json.Get(health, "app"), "codex-token-strip")) throw new IOException("Unexpected local service");
        if ((Json.Number(health, "version") ?? 0) < 1) throw new IOException("Statistics service needs update");
        var source = Json.Parse(Get("metrics?pid=" + processId.ToString(Invariant)));
        var available = Object.Equals(Json.Get(source, "available"), true);
        var binding = Json.Map(source, "binding");
        var total = Json.Map(source, "total");
        var cost = Json.Map(source, "cost");
        var tokens = Json.Number(source, "tokens");
        var speed = Json.Number(source, "speed");
        var hit = Json.Number(Json.Map(source, "cacheHit"), "percent");
        var result = new Metrics { Available = available,
            ThreadId = Convert.ToString(Json.Get(binding, "threadId"), Invariant),
            BindingStatus = Convert.ToString(Json.Get(binding, "status"), Invariant),
            TotalReady = Object.Equals(Json.Get(total, "available"), true) };
        result.Money = "会话 " + (!available ? result.BindingStatus == "cloud-chat" ? "云端未上报" : "—" : Price(cost));
        result.Total = "总计 " + (!result.TotalReady ? "…" : Price(total));
        result.Tokens = available && tokens.HasValue ? " · " + Compact(tokens.Value) + " tokens" : "";
        result.Speed = available && speed.HasValue ? "≈" + speed.Value.ToString("F1", Invariant) + " tok/s" : "— tok/s";
        result.Cache = "缓存命中 " + (available && hit.HasValue ? hit.Value.ToString("F1", Invariant) + "%" : "—");
        var detail = new StringBuilder();
        if (!String.IsNullOrEmpty(result.ThreadId)) detail.AppendLine("自动跟随当前会话：" + result.ThreadId);
        else detail.AppendLine("当前页面没有可读取的本地会话数据（" + result.BindingStatus + "）。");
        if (result.BindingStatus == "cloud-chat") detail.AppendLine("已识别到云端聊天，但本机没有它的 Token 用量记录，无法计算美元消耗和生成速度。");
        detail.AppendLine("总计：本机所有可读取的会话及归档，包含当前会话。");
        detail.AppendLine("相同请求 ID 跨分叉/归档只计一次。");
        detail.AppendLine("美元为 API Token 等价估算，不是订阅扣费或剩余额度。");
        detail.AppendLine("速度为最近完成请求的平均估算，响应结束后更新。");
        var rows = Json.Get(cost, "breakdown") as IEnumerable;
        if (rows != null) foreach (var value in rows)
        {
            var row = value as Dictionary<string, object>;
            if (row == null) continue;
            detail.AppendLine(Convert.ToString(Json.Get(row, "model"), Invariant));
            detail.AppendFormat(Invariant, "输入 ${0:F4} · 缓存输入 ${1:F4}\n缓存写入 ${2:F4} · 输出 ${3:F4}\n",
                Json.Number(row, "inputUSD") ?? 0, Json.Number(row, "cachedInputUSD") ?? 0,
                Json.Number(row, "cacheWriteUSD") ?? 0, Json.Number(row, "outputUSD") ?? 0);
        }
        if (available && !Object.Equals(Json.Get(cost, "complete"), true)) detail.AppendLine("当前会话部分请求缺少价格，金额仅包含已知部分。");
        if (result.TotalReady)
        {
            detail.AppendFormat(Invariant, "总计覆盖 {0} 个本地会话、{1} 个唯一请求。\n", Json.Number(total, "sessions") ?? 0, Json.Number(total, "requests") ?? 0);
            if (!Object.Equals(Json.Get(total, "complete"), true)) detail.AppendLine("总计存在未知模型价格、旧格式或缺失记录；≥ 表示已知部分的下界。");
            var unpriced = Json.Get(total, "unpricedModels") as IEnumerable;
            if (unpriced != null)
            {
                var names = new List<string>();
                foreach (var model in unpriced) names.Add(Convert.ToString(model, Invariant));
                if (names.Count > 0) detail.AppendLine("未计价模型：" + String.Join("、", names.ToArray()));
            }
        }
        detail.Append("拖动可调整位置；右键可隐藏或退出。");
        result.Details = detail.ToString();
        return result;
    }
    private static string Price(Dictionary<string, object> cost)
    {
        var usd = Json.Number(cost, "usd");
        return !usd.HasValue ? "待计价" : (Object.Equals(Json.Get(cost, "complete"), true) ? "≈$" : "≥$") +
            usd.Value.ToString(usd.Value > 0 && usd.Value < .01 ? "F4" : "F2", Invariant);
    }
    private static string Compact(double value)
    {
        if (value >= 1e9) return (value / 1e9).ToString("0.#", Invariant) + "B";
        if (value >= 1e6) return (value / 1e6).ToString("0.#", Invariant) + "M";
        if (value >= 1e3) return (value / 1e3).ToString("0.#", Invariant) + "K";
        return value.ToString("0", Invariant);
    }
}

internal sealed class Settings
{
    public double CenterFraction = .59;
    public double BottomInset = 9;
    public string Theme = "auto";
    public string NodePath = "";
    public int Port = 23957;
    public string CodexHome = "";
    public string LogRoot = "";

    internal static Settings Load(string root)
    {
        var file = Path.Combine(root, "settings.json");
        var value = File.Exists(file) ? new JavaScriptSerializer().Deserialize<Settings>(File.ReadAllText(file)) : new Settings();
        if (value == null) value = new Settings();
        var port = Environment.GetEnvironmentVariable("CODEX_TOKEN_STRIP_PORT");
        if (!String.IsNullOrEmpty(port)) value.Port = Int32.Parse(port, CultureInfo.InvariantCulture);
        if (value.Port < 1 || value.Port > 65535) throw new IOException("Port must be between 1 and 65535.");
        return value;
    }

    internal string FindNode()
    {
        var candidates = new List<string>();
        candidates.Add(Environment.GetEnvironmentVariable("CODEX_TOKEN_STRIP_NODE"));
        candidates.Add(NodePath);
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"));
        var search = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var directory in search.Split(';'))
        {
            try { if (!String.IsNullOrWhiteSpace(directory)) candidates.Add(Path.Combine(directory.Trim('"'), "node.exe")); }
            catch (ArgumentException) { }
        }
        foreach (var candidate in candidates) if (!String.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;
        return null;
    }
}

internal sealed class Strip : Form
{
    private readonly string root;
    private readonly Settings settings;
    private readonly System.Windows.Forms.Timer follow = new System.Windows.Forms.Timer();
    private readonly ToolTip tooltip = new ToolTip();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly ContextMenuStrip menu = new ContextMenuStrip();
    private Metrics data = new Metrics();
    private IntPtr target;
    private Native.RECT targetBounds;
    private bool busy, dragging, paused, stale = true, renderedDark, renderedCompact;
    private float scale = 1, renderedScale;
    private string renderedLine = "";
    private DateTime nextRead = DateTime.MinValue, nextBackendStart = DateTime.MinValue, nextReport = DateTime.MinValue;
    private DateTime nextThemeCheck = DateTime.MinValue;
    private bool systemDark;
    private Point dragCursor, dragStart;
    private int targetPid;
    private readonly List<object> bindings = new List<object>();

    internal Strip(string directory)
    {
        root = directory;
        settings = Settings.Load(root);
        if (settings.FindNode() == null) throw new IOException("未找到 Node.js。请安装 Node.js 22 或更新版本，或在 settings.json 中填写 NodePath。");
        if (Double.IsNaN(settings.CenterFraction) || settings.CenterFraction < 0 || settings.CenterFraction > 1) settings.CenterFraction = .59;
        if (Double.IsNaN(settings.BottomInset) || settings.BottomInset < 0 || settings.BottomInset > 1000) settings.BottomInset = 9;
        Text = "Codex Token 小浮条";
        AccessibleName = Text;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(1, 1);
        Location = new Point(-10000, -10000);
        menu.Items.Add("拖动浮条可对齐输入框").Enabled = false;
        menu.Items.Add("自动跟随当前聊天 · 总计包含全部本地会话").Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("恢复默认位置", null, delegate { settings.CenterFraction = .59; settings.BottomInset = 9; SaveSettings(); UpdateTarget(); });
        var themes = new ToolStripMenuItem("外观");
        themes.DropDownItems.Add("跟随系统", null, delegate { SetTheme("auto"); });
        themes.DropDownItems.Add("浅色", null, delegate { SetTheme("light"); });
        themes.DropDownItems.Add("深色", null, delegate { SetTheme("dark"); });
        menu.Items.Add(themes);
        menu.Items.Add("隐藏／显示", null, delegate { paused = !paused; UpdateTarget(); });
        menu.Items.Add("退出浮条", null, delegate { Close(); });
        ContextMenuStrip = menu;
        tray.Icon = SystemIcons.Information;
        tray.Text = "Codex Token 小浮条 · 拖动定位，右键退出";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { paused = !paused; UpdateTarget(); };
        tooltip.InitialDelay = 500;
        tooltip.AutoPopDelay = 20000;
        tooltip.ShowAlways = true;
        follow.Interval = 150;
        follow.Tick += delegate { UpdateTarget(); };
        follow.Start();
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000 | 0x00080000 | 0x00000080; return value; }
    }
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
        base.WndProc(ref message);
    }
    protected override void OnShown(EventArgs e) { base.OnShown(e); UpdateTarget(); }
    private void SetTheme(string theme) { settings.Theme = theme; SaveSettings(); renderedLine = ""; UpdateTarget(); }
    private void SaveSettings()
    {
        try { File.WriteAllText(Path.Combine(root, "settings.json"), Json.Stringify(settings), Encoding.UTF8); } catch { }
    }

    private void UpdateTarget()
    {
        if (IsDisposed || dragging) return;
        var active = Native.GetForegroundWindow();
        var owner = Native.GetAncestor(active, 3); // GA_ROOTOWNER, metadata only
        uint process;
        Native.GetWindowThreadProcessId(owner, out process);
        var ownProcess = process == (uint)Process.GetCurrentProcess().Id;
        if (paused || (ownProcess && !menu.Visible) || (!ownProcess && !Native.IsOfficialCodex(process)) || Native.IsIconic(owner))
        { Native.ShowWindow(Handle, 0); Report(false); return; }
        if (!ownProcess)
        {
            if (owner != target)
            {
                target = owner; targetPid = (int)process;
                // Changes this tiny window's owner; the Codex window is untouched.
                Native.SetWindowLongPtr(Handle, -8, target);
            }
            Native.RECT rect;
            if (!Native.GetClientRect(target, out rect)) { Native.ShowWindow(Handle, 0); return; }
            var origin = new Native.POINT(0, 0);
            Native.ClientToScreen(target, ref origin);
            targetBounds = new Native.RECT { Left = origin.X, Top = origin.Y, Right = origin.X + rect.Right, Bottom = origin.Y + rect.Bottom };
            if (rect.Right < 350 || rect.Bottom < 200) { Native.ShowWindow(Handle, 0); return; }
            try { scale = Native.GetDpiForWindow(target) / 96f; } catch (EntryPointNotFoundException) { scale = 1; }
        }
        if (target == IntPtr.Zero) return;
        if (DateTime.UtcNow >= nextThemeCheck) { systemDark = IsDark(); nextThemeCheck = DateTime.UtcNow.AddSeconds(5); }
        bool dark = settings.Theme == "dark" || (settings.Theme == "auto" && systemDark);
        bool compact = targetBounds.Right - targetBounds.Left < 620 * scale;
        if (renderedLine != data.Line + stale || renderedScale != scale || renderedDark != dark || renderedCompact != compact)
        {
            using (var image = Render(data, scale, dark, stale, compact))
            {
                Size = image.Size;
                Place();
                Native.Paint(Handle, image, Location);
            }
            renderedLine = data.Line + stale; renderedScale = scale; renderedDark = dark; renderedCompact = compact;
            AccessibleName = "当前聊天统计：" + data.Line + (stale ? "，连接暂不可用" : "");
            tooltip.SetToolTip(this, data.Details + (stale ? "\n统计连接暂不可用，正在重试。" : ""));
        }
        Place();
        Native.SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, 0x0010 | 0x0040); // only our window, no activation
        Report(true);
        if (!busy && DateTime.UtcNow >= nextRead) { nextRead = DateTime.UtcNow.AddSeconds(1); ReadMetrics(); }
    }
    private void Place()
    {
        var x = (int)(targetBounds.Left + (targetBounds.Right - targetBounds.Left) * settings.CenterFraction - Width / 2.0);
        var y = targetBounds.Bottom - Height - (int)(settings.BottomInset * scale);
        Location = new Point(Math.Max(targetBounds.Left + 4, Math.Min(x, targetBounds.Right - Width - 4)),
            Math.Max(targetBounds.Top + 4, Math.Min(y, targetBounds.Bottom - Height - 4)));
    }
    private static bool IsDark()
    {
        try { return Convert.ToInt32(Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1)) == 0; }
        catch { return false; }
    }
    private async void ReadMetrics()
    {
        busy = true;
        var requestedPid = targetPid;
        try
        {
            var next = await Task.Run(() => Metrics.Fetch(requestedPid));
            if (targetPid != requestedPid) return;
            if (next.ThreadId != data.ThreadId || next.BindingStatus != data.BindingStatus)
            {
                bindings.Add(new { threadId = next.ThreadId, status = next.BindingStatus, timestamp = DateTime.UtcNow.ToString("o") });
                if (bindings.Count > 8) bindings.RemoveAt(0);
            }
            data = next; stale = false;
        }
        catch (Exception)
        {
            stale = true; data.Speed = "— tok/s"; data.Money = "会话 —"; data.Tokens = "";
            data.ThreadId = ""; data.BindingStatus = "disconnected"; data.Cache = "缓存命中 —";
            if (DateTime.UtcNow >= nextBackendStart) { nextBackendStart = DateTime.UtcNow.AddSeconds(30); StartBackend(); }
        }
        finally { busy = false; }
        if (!IsDisposed) UpdateTarget();
    }
    private void StartBackend()
    {
        try
        {
            var node = settings.FindNode();
            if (node == null) return;
            var script = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "server.cjs"));
            var start = new ProcessStartInfo(node, "\"" + script + "\"");
            start.WorkingDirectory = Path.GetDirectoryName(script);
            start.EnvironmentVariables["CODEX_TOKEN_STRIP_DATA_DIR"] = root;
            start.EnvironmentVariables["CODEX_TOKEN_STRIP_PORT"] = settings.Port.ToString(CultureInfo.InvariantCulture);
            start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
            using (var child = Process.Start(start)) { }
        }
        catch { }
    }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        dragging = true; dragCursor = Cursor.Position; dragStart = Location; Capture = true;
    }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (!dragging) return;
        var cursor = Cursor.Position;
        Location = new Point(dragStart.X + cursor.X - dragCursor.X, dragStart.Y + cursor.Y - dragCursor.Y);
        Native.SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, 0x0010);
    }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (!dragging) return;
        dragging = false; Capture = false;
        if (targetBounds.Right > targetBounds.Left)
        {
            settings.CenterFraction = Math.Max(0, Math.Min(1, (Left + Width / 2.0 - targetBounds.Left) / (targetBounds.Right - targetBounds.Left)));
            settings.BottomInset = Math.Max(0, (targetBounds.Bottom - Bottom) / scale);
            SaveSettings();
        }
        UpdateTarget();
    }
    private void Report(bool visible)
    {
        if (DateTime.UtcNow < nextReport) return;
        nextReport = DateTime.UtcNow.AddSeconds(3);
        try { File.WriteAllText(Path.Combine(root, "runtime.json"), Json.Stringify(new {
            pid = Process.GetCurrentProcess().Id, visible = visible, targetPid = targetPid,
            officialClient = target != IntPtr.Zero, left = Left, top = Top, width = Width, height = Height,
            connected = !stale, text = data.Line, workingSetBytes = Process.GetCurrentProcess().WorkingSet64,
            foregroundImage = Native.LastImage,
            timestamp = DateTime.UtcNow.ToString("o"), boundChat = data.ThreadId,
            bindingStatus = data.BindingStatus, automatic = true, totalReady = data.TotalReady, bindingHistory = bindings.ToArray()
        }), Encoding.UTF8); } catch { }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { follow.Dispose(); tooltip.Dispose(); tray.Visible = false; tray.Dispose(); menu.Dispose(); }
        base.Dispose(disposing);
    }

    internal static Bitmap Render(Metrics value, float scale, bool dark, bool stale, bool compact = false)
    {
        using (var font = new Font("Microsoft YaHei UI", 12 * scale, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var small = new Font("Segoe UI", 11 * scale, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var measure = new Bitmap(1, 1))
        using (var graphics = Graphics.FromImage(measure))
        {
            var money = graphics.MeasureString(value.Money, font).Width;
            var total = graphics.MeasureString(value.Total, font).Width;
            var tokenText = compact ? "" : value.Tokens;
            var cacheText = compact ? value.Cache.Replace("缓存命中 ", "缓存 ") : value.Cache;
            var tokens = tokenText.Length == 0 ? 0 : graphics.MeasureString(tokenText, small).Width;
            var speed = graphics.MeasureString(value.Speed, font).Width;
            var cache = graphics.MeasureString(cacheText, font).Width;
            var image = new Bitmap((int)Math.Ceiling(money + tokens + total + speed + cache + 119 * scale), (int)Math.Ceiling(27 * scale), PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(image))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                var background = dark ? Color.FromArgb(240, 28, 28, 28) : Color.FromArgb(240, 255, 255, 255);
                var foreground = dark ? Color.FromArgb(165, 168, 177) : Color.FromArgb(125, 130, 140);
                if (stale) foreground = Color.FromArgb(115, foreground);
                using (var shape = Rounded(new RectangleF(1, 1, image.Width - 2, image.Height - 2), 11 * scale))
                using (var fill = new SolidBrush(background))
                using (var border = new Pen(dark ? Color.FromArgb(35, 200, 200, 200) : Color.FromArgb(18, 110, 110, 110), 1))
                { g.FillPath(fill, shape); g.DrawPath(border, shape); }
                using (var ink = new SolidBrush(foreground))
                using (var pen = new Pen(foreground, 1.2f * scale))
                {
                    var x = 12 * scale; var y = 4 * scale;
                    g.DrawString(value.Money, font, ink, x, y); x += money;
                    g.DrawString(tokenText, small, ink, x, y + scale); x += tokens + 17 * scale;
                    g.DrawString(value.Total, font, ink, x, y); x += total + 17 * scale;
                    g.DrawArc(pen, x, 8 * scale, 12 * scale, 12 * scale, 145, 250);
                    g.DrawLine(pen, x + 6 * scale, 14 * scale, x + 10 * scale, 10 * scale); x += 17 * scale;
                    g.DrawString(value.Speed, font, ink, x, y); x += speed + 17 * scale;
                    g.DrawEllipse(pen, x, 7 * scale, 10 * scale, 4 * scale);
                    g.DrawLine(pen, x, 9 * scale, x, 18 * scale);
                    g.DrawLine(pen, x + 10 * scale, 9 * scale, x + 10 * scale, 18 * scale);
                    g.DrawArc(pen, x, 12 * scale, 10 * scale, 4 * scale, 0, 180);
                    g.DrawArc(pen, x, 16 * scale, 10 * scale, 4 * scale, 0, 180); x += 15 * scale;
                    g.DrawString(cacheText, font, ink, x, y);
                }
            }
            return image;
        }
    }
    private static GraphicsPath Rounded(RectangleF rect, float radius)
    {
        var path = new GraphicsPath(); var diameter = radius * 2;
        path.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90, 90); path.CloseFigure(); return path;
    }
}

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct POINT { internal int X, Y; internal POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] internal struct SIZE { internal int Width, Height; internal SIZE(int w, int h) { Width = w; Height = h; } }
    [StructLayout(LayoutKind.Sequential)] internal struct RECT { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] internal struct BLEND { internal byte Op, Flags, Alpha, Format; }
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] internal static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screen, ref POINT destination, ref SIZE size, IntPtr dc, ref POINT source, int key, ref BLEND blend, int flags);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int length);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static uint lastPid;
    internal static string LastImage = "";
    private static bool lastTrusted;
    private static DateTime nextCheck;
    internal static bool IsOfficialCodex(uint pid)
    {
        if (pid == 0) return false;
        if (pid == lastPid && DateTime.UtcNow < nextCheck) return lastTrusted;
        var file = ProcessImage(pid);
        var prefix = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"WindowsApps\OpenAI.Codex_");
        var result = file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
            (file.EndsWith(@"\app\ChatGPT.exe", StringComparison.OrdinalIgnoreCase) || file.EndsWith(@"\app\Codex.exe", StringComparison.OrdinalIgnoreCase));
        lastPid = pid; LastImage = file; lastTrusted = result; nextCheck = DateTime.UtcNow.AddSeconds(5); return result;
    }
    internal static string ProcessImage(uint pid)
    {
        var process = OpenProcess(0x1000, false, pid);
        if (process != IntPtr.Zero)
        {
            try
            {
                var path = new StringBuilder(32768); var size = path.Capacity;
                if (QueryFullProcessImageName(process, 0, path, ref size))
                {
                    return path.ToString();
                }
            }
            finally { CloseHandle(process); }
        }
        return "";
    }
    internal static void Paint(IntPtr window, Bitmap image, Point position)
    {
        var screen = GetDC(IntPtr.Zero); var dc = CreateCompatibleDC(screen);
        var bitmap = image.GetHbitmap(Color.FromArgb(0)); var previous = SelectObject(dc, bitmap);
        try
        {
            var destination = new POINT(position.X, position.Y); var size = new SIZE(image.Width, image.Height); var source = new POINT(0, 0);
            var blend = new BLEND { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
            if (!UpdateLayeredWindow(window, screen, ref destination, ref size, dc, ref source, 0, ref blend, 2))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { SelectObject(dc, previous); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(IntPtr.Zero, screen); }
    }
}

// 本币货币债券工作台 Windows 服务宿主（用 CVM 内置 csc.exe 编译为 mmb_svc.exe）。
// 作用：以 SYSTEM 身份开机自启并托管 server.py，server.py 退出则 2 秒后自动重启。
// 编译：csc.exe /target:exe /out:mmb_svc.exe /r:System.ServiceProcess.dll mmb_svc.cs
using System;
using System.IO;
using System.Diagnostics;
using System.ServiceProcess;
using System.Threading;

namespace MmbService {
  public class MmbService : ServiceBase {
    private Process proc;
    private Thread monitor;
    private volatile bool stopping = false;
    private string py = "C:/Program Files/Python313/python.exe";
    private string script = "C:/mmb/server.py";
    private string dir = "C:/mmb";
    public MmbService() {
      ServiceName = "MMB_Workbench";
      CanStop = true; CanShutdown = true; CanHandlePowerEvent = true;
    }
    private void Log(string s) {
      try { File.AppendAllText(dir + "/svc_out.log", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + s + "\n"); } catch {}
    }
    private void StartChild() {
      try {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = py;
        psi.Arguments = "\"" + script + "\"";
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.EnvironmentVariables["MMB_HOST"] = "0.0.0.0";
        psi.EnvironmentVariables["MMB_PORT"] = "8765";
        psi.EnvironmentVariables["MMB_REFRESH_MIN"] = "30";
        psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        proc = Process.Start(psi);
        Log("started pid=" + proc.Id);
      } catch (Exception ex) { Log("start fail: " + ex.Message); }
    }
    private void Monitor() {
      while (!stopping) {
        if (proc != null) {
          proc.WaitForExit();
          if (stopping) break;
          Log("exited code=" + proc.ExitCode + " restarting in 2s");
          Thread.Sleep(2000);
          if (!stopping) { proc = null; StartChild(); }
        } else { Thread.Sleep(2000); }
      }
    }
    protected override void OnStart(string[] args) {
      Log("OnStart");
      StartChild();
      monitor = new Thread(new ThreadStart(Monitor));
      monitor.IsBackground = true;
      monitor.Start();
    }
    protected override void OnStop() {
      Log("OnStop");
      stopping = true;
      try { if (proc != null && !proc.HasExited) proc.Kill(); } catch {}
      try { if (proc != null) proc.WaitForExit(5000); } catch {}
    }
    protected override void OnShutdown() { OnStop(); }
  }
  public class Program {
    public static void Main() {
      ServiceBase.Run(new MmbService());
    }
  }
}

using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

/// <summary>
/// Chrome native messaging hosts must be a real executable, so this tiny
/// launcher starts `node host.js` with the exact stdin/stdout/stderr handles
/// that Chrome created for the native host process.
///
/// Process.Start() does not reliably pass inherited pipe handles through, so
/// CreateProcess is called directly with STARTF_USESTDHANDLES.
/// </summary>
internal static class NexusHostLauncher
{
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string node = FindNode(dir);
        if (node == null)
        {
            Console.Error.WriteLine("NexusHost: node.exe not found. Re-run native-host/install.ps1.");
            return 2;
        }

        string script = Path.Combine(dir, "host.js");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("NexusHost: host.js not found: " + script);
            return 3;
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        string commandLine = Quote(node) + " " + Quote(script);

        bool ok = CreateProcess(
            null,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            0,
            IntPtr.Zero,
            dir,
            ref si,
            out pi);

        if (!ok)
        {
            int error = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("NexusHost: CreateProcess failed, Win32 error " + error);
            return 4;
        }

        try
        {
            WaitForSingleObject(pi.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode)) exitCode = 1;
            return unchecked((int)exitCode);
        }
        finally
        {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string FindNode(string dir)
    {
        try
        {
            string cfg = Path.Combine(dir, "node_path.txt");
            if (File.Exists(cfg))
            {
                string candidate = File.ReadAllText(cfg).Trim();
                if (candidate.Length > 0 && File.Exists(candidate)) return candidate;
            }
        }
        catch
        {
            // fall through to PATH lookup
        }

        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (string part in pathEnv.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(part.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // ignore malformed PATH entries
            }
        }
        return null;
    }
}

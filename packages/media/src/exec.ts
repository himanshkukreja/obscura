import { spawn } from 'node:child_process';
import { ObscuraError, ErrorCodes } from '@obscura/shared';

export interface RunResult { stdout: string; stderr: string }

/**
 * Run a media tool. Arguments are always an array - there is no shell, and no request
 * input is ever interpolated into a command string.
 */
export function run(
  bin: string,
  args: string[],
  opts: {
    onStderr?: (line: string) => void;
    timeoutMs?: number;
    signal?: AbortSignal;
    errorCode?: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const tail: string[] = [];

    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;

    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) for (const line of s.split(/\r?\n/)) if (line) opts.onStderr(line);
      // Keep only a bounded tail: ffmpeg stderr on a long job is enormous.
      tail.push(s);
      if (tail.length > 64) tail.shift();
    });

    child.on('error', (e) => done(() => reject(
      new ObscuraError(ErrorCodes.INTERNAL, `Failed to spawn ${bin}: ${e.message}`, { cause: e }),
    )));

    child.on('close', (code) => done(() => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = tail.join('').slice(-4000);
      reject(new ObscuraError(
        opts.errorCode ?? ErrorCodes.INTERNAL,
        `${bin} exited with code ${code}`,
        { retryable: true, detail: { exitCode: code, stderr: detail } },
      ));
    }));
  });
}

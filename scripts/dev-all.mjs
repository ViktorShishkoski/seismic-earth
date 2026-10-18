// Runs the relay and the dev server together: `npm run dev:all`.
// Each line is prefixed so you can tell which process is talking.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const jobs = [
  { name: 'relay', colour: '\x1b[36m', args: ['run', 'server'] },
  { name: 'web  ', colour: '\x1b[35m', args: ['run', 'dev'] },
];

const children = jobs.map(({ name, colour, args }) => {
  const child = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${colour}${name}\x1b[0m │ ${line}\n`);
    });
  };
  prefix(child.stdout);
  prefix(child.stderr);
  return child;
});

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) stop(); });

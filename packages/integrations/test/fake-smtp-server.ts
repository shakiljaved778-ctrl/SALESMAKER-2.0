import { createServer, type Socket } from 'node:net';

export interface CapturedMail {
  from: string;
  to: string[];
  data: string;
}

export interface FakeSmtpServer {
  port: number;
  messages: CapturedMail[];
  close(): Promise<void>;
}

/**
 * A minimal in-process SMTP receiver (RFC 5321 subset: EHLO, MAIL, RCPT, DATA, RSET, QUIT), so the
 * SMTP adapter is exercised in every test run without Mailpit or any network egress.
 */
export async function startFakeSmtpServer(): Promise<FakeSmtpServer> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let current: CapturedMail = { from: '', to: [], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake-smtp ready');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end).replace(/\r\n/g, '\n').replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: '', to: [], data: '' };
          reply('250 2.0.0 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
        if (verb === 'EHLO' || verb === 'HELO') reply('250 fake-smtp');
        else if (verb === 'MAIL') {
          current.from = address;
          reply('250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          current.to.push(address);
          reply('250 2.1.5 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 end with <CRLF>.<CRLF>');
        } else if (verb === 'RSET') {
          current = { from: '', to: [], data: '' };
          reply('250 ok');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('502 command not implemented');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    messages,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// Can the gateway's outgoing TCP use a per-player loopback source address (127.x.y.z)?
// Everything on an ephemeral port of this process; nothing else is contacted.
import { createServer, connect } from "node:net";

const server = createServer((socket) => { seen.push(socket.remoteAddress); socket.end(); });
const seen = [];
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const results = [];
for (const localAddress of ["127.0.0.1", "127.0.0.2", "127.23.45.67", "127.255.255.254"]) {
  const outcome = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, localAddress });
    socket.once("connect", () => resolve("connected"));
    socket.once("error", (error) => resolve(`error ${error.code}`));
    socket.once("close", () => {});
    socket.resume();
  });
  results.push({ localAddress, outcome });
}
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(JSON.stringify({ results, serverSaw: seen }));
server.close();

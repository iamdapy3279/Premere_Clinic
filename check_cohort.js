async function request(method, path) {
  const res = await fetch(`http://127.0.0.1:5173${path}`, { method });
  return res.json();
}

async function check() {
  const status = await request('GET', '/api/status');
  console.log(JSON.stringify(status, null, 2));
}

check();

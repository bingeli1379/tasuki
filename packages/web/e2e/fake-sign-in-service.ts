import { createServer } from 'node:http'

// Stands in for a company's sign-in API that @tasuki/auth-http asks (security-and-auth.md).
const people: Record<string, { userId: string; displayName: string; password: string }> = {
  eli: { userId: 'emp-001', displayName: 'Eli Ye', password: 'company password' },
  amy: { userId: 'emp-002', displayName: 'Amy Lin', password: 'company password' },
}

createServer((req, res) => {
  if (req.method === 'GET') return void res.end('ok')
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const { username, password } = JSON.parse(body) as { username: string; password: string }
    const person = people[username]
    const ok = person !== undefined && person.password === password
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(ok ? JSON.stringify({ userId: person.userId, displayName: person.displayName }) : '{}')
  })
}).listen(Number(process.argv[2]), '127.0.0.1')

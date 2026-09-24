// anchor-auth/index.js
// npm i express anchor-link
// run: PORT=3003 node index.js
const express = require('express')
const AnchorLink = require('anchor-link')

const CHAIN_ID = 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906'
const NODE_URL = 'https://vaulta.greymass.com'
const PORT = process.env.PORT || 3003
const TTL_MS = 10 * 60 * 1000 // login requests valid 10 min

// A throwaway link per request whose only job is to emit the esr:// URI.
function makeCapturingLink(onUri) {
  const transport = {
    onRequest(request) { onUri(request.encode()) }, // esr:// string
    onSessionRequest() {},
    onSuccess() {}, onFailure() {},
  }
  return new AnchorLink({
    transport,
    chains: [{ chainId: CHAIN_ID, nodeUrl: NODE_URL }],
  })
}

// pending[chatId]   = { account, uri, createdAt }
// completed[chatId] = { requestedAccount, account, verified, reason, at, fetched }
const pending = {}
const completed = {}

// Verify the signed identity proof really belongs to the account, by
// recovering the signing key and checking it against the account's on-chain
// authority. This is what makes the login trustworthy.
async function verifyProof(link, proof) {
  try {
    const signer = proof.signer
    const actor = String(signer.actor)
    const permission = String(signer.permission)
    const account = await link.client.v1.chain.get_account(actor)
    const perm = account.permissions.find(
      (p) => String(p.perm_name) === permission
    )
    if (!perm) {
      return { ok: false, signer: `${actor}@${permission}`, reason: 'permission not found' }
    }
    const recovered = String(proof.recover())
    const authorized = perm.required_auth.keys.some(
      (k) => String(k.key) === recovered
    )
    return {
      ok: authorized,
      actor,
      signer: `${actor}@${permission}`,
      reason: authorized ? '' : 'signing key not authorized for this account',
    }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

const app = express()
app.use(express.json())

// ===== Flow A: start a login, return the esr:// URI to show on WhatsApp =====
app.post('/auth/start', (req, res) => {
  const { chatId, account } = req.body || {}
  if (!chatId) return res.status(400).json({ error: 'chatId required' })

  let uri = null
  const link = makeCapturingLink((u) => { uri = u })

  // Resolves when the user approves in Anchor (could be minutes later).
  link.login(`coupon-${chatId}`)
    .then(async ({ proof }) => {
      const v = await verifyProof(link, proof)
      completed[chatId] = {
        requestedAccount: account || '',
        account: v.actor || (proof.signer ? String(proof.signer.actor) : ''),
        signer: v.signer || '',
        verified: v.ok,
        reason: v.reason || '',
        at: Date.now(),
        fetched: false,
      }
      delete pending[chatId]
    })
    .catch((e) => {
      completed[chatId] = {
        requestedAccount: account || '',
        account: '',
        verified: false,
        reason: String((e && e.message) || e),
        at: Date.now(),
        fetched: false,
      }
      delete pending[chatId]
    })

  // Give the transport a moment to produce the URI, then return it.
  setTimeout(() => {
    pending[chatId] = { account: account || '', uri, createdAt: Date.now() }
    res.json({ uri, account: account || '' })
  }, 1000)
})

// ===== Flow B: poll newly completed logins (n8n calls this every 10s) =====
app.get('/auth/completed', (req, res) => {
  const now = Date.now()
  for (const [id, v] of Object.entries(pending)) {
    if (now - v.createdAt > TTL_MS) delete pending[id]
  }
  const out = []
  for (const [chatId, v] of Object.entries(completed)) {
    if (!v.fetched) { v.fetched = true; out.push({ chatId, ...v }) }
  }
  for (const [id, v] of Object.entries(completed)) {
    if (v.fetched && now - v.at > TTL_MS) delete completed[id]
  }
  res.json(out)
})

app.get('/health', (req, res) => res.json({ ok: true }))

app.listen(PORT, () =>
  console.log(`anchor-auth :${PORT}  (POST /auth/start, GET /auth/completed)`))
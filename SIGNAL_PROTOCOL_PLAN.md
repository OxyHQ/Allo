# Signal Protocol Implementation Plan

Full Signal Protocol integration for Allo, matching WhatsApp's approach.
No backward compatibility — old crypto code gets replaced entirely.

---

## What Gets Deleted

All current "encryption" is fake Signal Protocol — it's just a one-shot ECDH + AES-GCM
with no sessions, no ratcheting, no forward secrecy. Remove it completely.

### Files to delete or gut:

| File | Action |
|------|--------|
| `frontend/lib/signalProtocol.ts` | **Rewrite entirely** — replace P-256/ECDH/AES-GCM with real Signal Protocol |
| `frontend/stores/deviceKeysStore.ts` | **Rewrite entirely** — needs session management, not just raw key encrypt/decrypt |
| `frontend/lib/p2pMessaging.ts` | **Rewrite** — P2P layer must use Signal sessions, not raw encrypt/decrypt |
| `backend/src/utils/signalProtocol.ts` | **Rewrite** — update validation for new message format |
| `backend/src/models/Message.ts` | **Clean up** — remove legacy `text`/`media` fields, remove `encryptionVersion` (only one version now) |
| `backend/src/models/Device.ts` | **Update** — Curve25519 keys instead of P-256, add pre-key consumption tracking |
| `backend/src/routes/devices.ts` | **Update** — add pre-key bundle fetch (with consumption), pre-key replenishment |
| `backend/src/routes/messages.ts` | **Clean up** — remove plaintext fallback, all messages must be encrypted |

### Code to remove from consumers:

| File | What to remove |
|------|---------------|
| `frontend/stores/messagesStore.ts` | Plaintext fallback in `sendMessage`, legacy `text` field handling in `fetchMessages` |
| `frontend/hooks/useRealtimeMessaging.ts` | Plaintext message handling, legacy decryption path |
| `frontend/lib/validation/schemas.ts` | Update schemas — `ciphertext` required, remove optional `text` |
| `frontend/lib/appInitializer.ts` | Update `initializeSignalProtocol()` for new key format |

---

## Architecture (How WhatsApp Does It)

```
                    ┌─────────────────────────────────────┐
                    │          Signal Protocol             │
                    │                                      │
                    │  ┌───────────┐   ┌────────────────┐  │
                    │  │   X3DH    │   │ Double Ratchet  │  │
                    │  │ (session  │──▶│ (per-message    │  │
                    │  │  setup)   │   │  encryption)    │  │
                    │  └───────────┘   └────────────────┘  │
                    │                                      │
                    │  ┌──────────────────────────────────┐│
                    │  │    Sender Keys (groups)           ││
                    │  │ Distributed via pairwise sessions ││
                    │  └──────────────────────────────────┘│
                    └─────────────────────────────────────┘
```

### Curve: **Curve25519** (not P-256)
- X25519 for Diffie-Hellman key agreement
- Ed25519 for signatures
- This is what Signal, WhatsApp, and Google Messages use

---

## Phase 1 — Crypto Foundation & Library

### 1.1 Choose and integrate Signal Protocol library

**Recommended: `@nicolo-ribaudo/libsignal-protocol-typescript`** (pure TypeScript port of libsignal)

Why:
- Pure TS — works on Expo/React Native + Web without native modules
- Implements X3DH, Double Ratchet, Sender Keys
- No C/Rust FFI needed (unlike `libsignal-client` which requires native bindings)

Alternative: **Build from primitives** using `@noble/curves` (X25519/Ed25519) + `@noble/ciphers` (AES-CBC) + `@noble/hashes` (HMAC-SHA256, HKDF)
- More control, fewer dependencies
- More work, more room for bugs
- `@noble/*` are audited, zero-dependency, pure JS

**Decision needed: library vs primitives?**

### 1.2 Implement `SignalProtocolStore`

The library requires a `StorageType` implementation that persists:

```typescript
interface SignalProtocolStore {
  // Identity keys
  getIdentityKeyPair(): Promise<KeyPair>
  getLocalRegistrationId(): Promise<number>
  saveIdentity(identifier: string, publicKey: ArrayBuffer): Promise<boolean>
  isTrustedIdentity(identifier: string, publicKey: ArrayBuffer, direction: Direction): Promise<boolean>

  // Pre-keys
  loadPreKey(keyId: number): Promise<KeyPair>
  storePreKey(keyId: number, keyPair: KeyPair): Promise<void>
  removePreKey(keyId: number): Promise<void>

  // Signed pre-keys
  loadSignedPreKey(keyId: number): Promise<KeyPair>
  storeSignedPreKey(keyId: number, keyPair: KeyPair): Promise<void>
  removeSignedPreKey(keyId: number): Promise<void>

  // Sessions
  loadSession(identifier: string): Promise<SessionRecord | undefined>
  storeSession(identifier: string, record: SessionRecord): Promise<void>
  removeSession(identifier: string): Promise<void>
  removeAllSessions(identifier: string): Promise<void>

  // Sender Keys (for groups)
  storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>
  loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord | undefined>
}
```

Storage backend:
- **Native (iOS/Android):** Expo SecureStore for private keys, SQLite for sessions (sessions can be large)
- **Web:** IndexedDB for all (encrypted at rest with a key derived from user's auth token)

### 1.3 Key Generation

Replace current P-256 key generation with Curve25519:

```typescript
// Identity Key Pair: long-lived, identifies the device
identityKeyPair: X25519KeyPair + Ed25519KeyPair

// Signed Pre-Key: medium-lived (rotate every ~7 days), signed by identity key
signedPreKey: {
  keyId: number
  keyPair: X25519KeyPair
  signature: Ed25519Signature  // identity key signs the public pre-key
  timestamp: number
}

// One-Time Pre-Keys: single-use, consumed on first message
preKeys: Array<{
  keyId: number
  keyPair: X25519KeyPair
}>  // Generate 100 initially, replenish when < 20 remain

// Registration ID: random uint32, identifies the registration
registrationId: number
```

### 1.4 Files changed

| File | Changes |
|------|---------|
| `frontend/lib/signalProtocol.ts` | Full rewrite: Curve25519 key gen, SignalProtocolStore, X3DH, Double Ratchet wrappers |
| `frontend/lib/secureStorage.ts` | Keep as-is (good abstraction) |
| `frontend/stores/deviceKeysStore.ts` | Rewrite: use new SignalProtocolStore, session-aware encrypt/decrypt |
| `package.json` (frontend) | Add `@nicolo-ribaudo/libsignal-protocol-typescript` OR `@noble/curves` + `@noble/ciphers` + `@noble/hashes` |

---

## Phase 2 — X3DH (Extended Triple Diffie-Hellman)

Session establishment between two devices, even when one is offline.

### 2.1 How it works

**Alice wants to message Bob (who may be offline):**

1. Alice fetches Bob's **pre-key bundle** from server:
   - Bob's identity key (IKB)
   - Bob's signed pre-key (SPKB) + signature
   - One of Bob's one-time pre-keys (OPKB) — **consumed** (deleted from server)

2. Alice generates an ephemeral key pair (EKA) and computes:
   ```
   DH1 = X25519(IKA_private, SPKB)
   DH2 = X25519(EKA_private, IKB)
   DH3 = X25519(EKA_private, SPKB)
   DH4 = X25519(EKA_private, OPKB)  // only if OPKB available
   SK  = HKDF(DH1 || DH2 || DH3 || DH4)
   ```

3. Alice sends initial message with: `IKA_public`, `EKA_public`, `OPKB_id` (which one-time pre-key was used)

4. Bob receives, computes the same shared secret SK, establishes session

### 2.2 Backend: Pre-Key Bundle Endpoint

New endpoint: `GET /api/devices/user/:userId/bundle/:deviceId`

```typescript
// Returns:
{
  identityKey: string,        // Base64 Curve25519 public key
  signedPreKey: {
    keyId: number,
    publicKey: string,        // Base64
    signature: string,        // Base64 Ed25519 signature
  },
  preKey?: {                  // One-time pre-key (nullable if none left)
    keyId: number,
    publicKey: string,        // Base64
  },
  registrationId: number,
}
```

**Critical:** The returned one-time pre-key is **atomically consumed** (deleted from DB) on fetch.
If no one-time pre-keys remain, X3DH still works (without DH4) but with slightly weaker properties.

### 2.3 Backend: Pre-Key Replenishment

New endpoint: `POST /api/devices/replenish-prekeys`

```typescript
// Client sends:
{
  deviceId: number,
  preKeys: Array<{ keyId: number, publicKey: string }>,
}
```

Client monitors pre-key count. When server has < 20 remaining, client generates and uploads a fresh batch of 100.

### 2.4 Files changed

| File | Changes |
|------|---------|
| `backend/src/routes/devices.ts` | Add bundle endpoint, add replenishment endpoint, make pre-key fetch atomic |
| `backend/src/models/Device.ts` | Add `preKeyCount` field, add index on preKeys for atomic pop |
| `frontend/lib/signalProtocol.ts` | Add X3DH initiator (Alice) and responder (Bob) logic |
| `frontend/stores/deviceKeysStore.ts` | Add `fetchPreKeyBundle()`, `establishSession()` |

---

## Phase 3 — Double Ratchet

Per-message forward secrecy and break-in recovery. This is the core of Signal Protocol.

### 3.1 How it works

Each session maintains:
```typescript
interface SessionState {
  // DH Ratchet
  DHs: X25519KeyPair      // Our current ratchet key pair
  DHr: X25519PublicKey     // Their current ratchet public key
  RK: Uint8Array           // Root key (32 bytes)

  // Sending chain
  CKs: Uint8Array          // Sending chain key
  Ns: number               // Message number (sending)

  // Receiving chain
  CKr: Uint8Array          // Receiving chain key
  Nr: number               // Message number (receiving)

  // Skipped message keys (for out-of-order delivery)
  MKSKIPPED: Map<string, Uint8Array>  // (ratchetPubKey, messageNumber) -> messageKey
}
```

**Sending a message:**
1. Advance sending chain: `CKs, MK = KDF_CK(CKs)`
2. Encrypt message with MK (AES-256-CBC + HMAC-SHA256)
3. Include in header: current DH ratchet public key, message number Ns, previous chain length
4. Increment Ns
5. Delete MK (forward secrecy!)

**Receiving a message:**
1. Check if sender's DH public key is new → if yes, perform DH ratchet step:
   - `RK, CKr = KDF_RK(RK, DH(DHs, DHr_new))`
   - Generate new DHs key pair
   - `RK, CKs = KDF_RK(RK, DH(DHs_new, DHr_new))`
2. Advance receiving chain: `CKr, MK = KDF_CK(CKr)`
3. Decrypt message with MK
4. Delete MK

**Out-of-order messages:**
- Cache skipped message keys (max ~2000) so late-arriving messages can be decrypted
- Each cached key is identified by (ratchet public key, message number)

### 3.2 Message Wire Format

```typescript
interface SignalMessage {
  // Header (plaintext — needed for routing)
  senderDeviceId: number
  senderIdentityKey: string       // For session lookup
  senderRatchetKey: string        // Current DH ratchet public key (Base64)
  messageNumber: number           // Counter in current sending chain
  previousChainLength: number     // Length of previous sending chain

  // Body (encrypted)
  ciphertext: string              // Base64: AES-256-CBC encrypted message
  mac: string                     // Base64: HMAC-SHA256 of header + ciphertext

  // Session metadata
  isPreKeyMessage: boolean        // True for first message (includes X3DH info)
  preKeyId?: number               // Which one-time pre-key was consumed
  signedPreKeyId?: number         // Which signed pre-key was used
  baseKey?: string                // Alice's ephemeral key (only in first message)
}
```

### 3.3 Files changed

| File | Changes |
|------|---------|
| `frontend/lib/signalProtocol.ts` | Double Ratchet: `ratchetEncrypt()`, `ratchetDecrypt()`, session state management |
| `frontend/stores/deviceKeysStore.ts` | Session-aware `encryptForSession()`, `decryptFromSession()` |
| `frontend/stores/messagesStore.ts` | Rewrite `sendMessage`: encrypt via session. Rewrite `fetchMessages`: decrypt via session |
| `frontend/hooks/useRealtimeMessaging.ts` | Rewrite decrypt path: use session-based decryption |
| `backend/src/models/Message.ts` | Update schema: add `senderRatchetKey`, `messageNumber`, `previousChainLength`, `isPreKeyMessage`, `baseKey`, `preKeyId`, `signedPreKeyId`. Remove `text`, `media`, `encryptionVersion` |
| `backend/src/routes/messages.ts` | Remove plaintext handling. All messages require ciphertext + signal headers |

---

## Phase 4 — Sender Keys (Group Messaging)

Efficient group encryption: sender encrypts once, all members decrypt.

### 4.1 How it works

1. Each group member generates a **Sender Key**: signing key + symmetric chain key
2. Sender Key is distributed to each group member via their **pairwise Signal session** (1:1 encrypted)
3. To send a group message: encrypt with your Sender Key chain (AES-256-CBC), sign with signing key
4. All group members who have your Sender Key can decrypt
5. Sender Key chain ratchets forward (like symmetric ratchet) for forward secrecy

### 4.2 Member changes

- **Member removed:** All remaining members generate **new** Sender Keys and redistribute. This ensures the removed member can't decrypt future messages.
- **Member added:** Existing members send their current Sender Keys to the new member via pairwise sessions.

### 4.3 Backend changes

New model: `SenderKeyDistribution` — tracks which Sender Keys have been distributed to whom.

```typescript
interface SenderKeyDistribution {
  groupId: string           // Conversation ID
  senderUserId: string      // Who owns this sender key
  senderDeviceId: number
  distributedTo: Array<{    // Who has received this sender key
    userId: string
    deviceId: number
    distributedAt: Date
  }>
  chainId: number           // Current chain iteration (increments on rotation)
}
```

### 4.4 Files changed

| File | Changes |
|------|---------|
| `frontend/lib/signalProtocol.ts` | Sender Key: generation, encrypt, decrypt, distribution message creation |
| `frontend/stores/deviceKeysStore.ts` | `createSenderKey()`, `distributeSenderKey()`, `processSenderKeyDistribution()` |
| `frontend/stores/messagesStore.ts` | Group send: use Sender Key encrypt. Group receive: use Sender Key decrypt |
| `backend/src/models/SenderKeyDistribution.ts` | **New file** — model for tracking Sender Key distribution |
| `backend/src/models/Conversation.ts` | No changes needed (groups already supported) |

---

## Phase 5 — Session Management & UX

### 5.1 Multi-device

Each message is encrypted **separately** for each of the recipient's devices.
For a group of 5, each with 2 devices: sender encrypts 1 time with Sender Key (group), but the Sender Key distribution was done via 8 pairwise sessions.

- On send: fetch all active devices for recipient → encrypt per device
- Device list cached locally, refreshed periodically

### 5.2 Pre-key lifecycle

| Event | Action |
|-------|--------|
| App startup | Check pre-key count on server, replenish if < 20 |
| After receiving PreKeyMessage | Remove consumed pre-key from local store |
| Every 7 days | Rotate signed pre-key, keep old one for 48h |
| On new device registration | Generate all keys, upload to server |

### 5.3 Safety numbers (identity verification)

When a contact's identity key changes (new device, reinstall):
- Show warning banner: "Security code changed for [contact]"
- Allow manual verification via QR code or 60-digit numeric code
- Safety number = hash(your identity key + their identity key)

### 5.4 Key backup (WhatsApp-style)

WhatsApp approach: encrypted backup to cloud.
- User sets a 6-digit PIN or passphrase
- Derive encryption key via Argon2 from PIN
- Encrypt all private keys + session state
- Upload encrypted blob to server
- On new device: enter PIN → decrypt → restore sessions

### 5.5 Files changed

| File | Changes |
|------|---------|
| `frontend/lib/signalProtocol.ts` | Safety number generation, key backup/restore |
| `frontend/stores/deviceKeysStore.ts` | Pre-key replenishment, signed pre-key rotation, backup/restore |
| `frontend/components/` | **New:** `SafetyNumberBanner.tsx`, `VerifyIdentityScreen.tsx`, `KeyBackupScreen.tsx` |
| `backend/src/routes/devices.ts` | Endpoint for pre-key count check, key backup storage |
| `backend/src/models/KeyBackup.ts` | **New file** — encrypted key backup storage |

---

## Phase 6 — Clean Up Backend

### 6.1 Message model (final)

```typescript
interface IMessage {
  conversationId: string
  senderId: string
  senderDeviceId: number

  // Signal Protocol envelope
  ciphertext: string                // Base64 encrypted content
  senderRatchetKey: string          // Base64 Curve25519 public key
  messageNumber: number
  previousChainLength: number
  isPreKeyMessage: boolean
  preKeyId?: number
  signedPreKeyId?: number
  baseKey?: string                  // Only in PreKeyMessage

  // Encrypted media (media metadata encrypted, files encrypted separately)
  encryptedMedia?: Array<{
    id: string
    type: "image" | "video" | "audio" | "file"
    ciphertext: string
    thumbnailCiphertext?: string
    fileName?: string
    fileSize?: number
    mimeType?: string
    width?: number
    height?: number
    duration?: number
  }>

  // Group messages (Sender Key)
  senderKeyGroupMessage?: boolean   // True if encrypted with Sender Key
  senderKeyChainId?: number         // Which sender key chain was used

  messageType: "text" | "media" | "system"
  replyTo?: string
  fontSize?: number
  editedAt?: Date
  deletedAt?: Date
  readBy: Map<string, Date>
  deliveredTo: string[]
  reactions?: Map<string, string[]>
  createdAt: Date
  updatedAt: Date
}
```

**Removed:** `text`, `media` (legacy plaintext), `encryptionVersion`

### 6.2 Device model (final)

```typescript
interface IDevice {
  userId: string
  deviceId: number

  // Curve25519 identity key
  identityKeyPublic: string         // Base64 Curve25519 public key

  // Signed pre-key (rotate every ~7 days)
  signedPreKey: {
    keyId: number
    publicKey: string               // Base64 Curve25519
    signature: string               // Base64 Ed25519 signature
    createdAt: Date
  }

  // One-time pre-keys (consumed on use)
  preKeys: Array<{
    keyId: number
    publicKey: string               // Base64 Curve25519
  }>
  preKeyCount: number               // Denormalized count for quick checks

  registrationId: number
  lastSeen: Date
  createdAt: Date
  updatedAt: Date
}
```

### 6.3 Backend validation

`backend/src/utils/signalProtocol.ts` — rewrite to validate new message format:
- Must have `ciphertext`
- Must have `senderRatchetKey`, `messageNumber`, `previousChainLength`
- Must have `senderDeviceId`
- `isPreKeyMessage` → must also have `baseKey`, `signedPreKeyId`

---

## Implementation Order

```
Phase 1 (Foundation)       [~3-4 days]
  ├── 1.1 Add library / crypto primitives
  ├── 1.2 Implement SignalProtocolStore
  └── 1.3 Rewrite key generation (Curve25519)

Phase 2 (X3DH)            [~2-3 days]
  ├── 2.1 Pre-key bundle endpoint (backend)
  ├── 2.2 Pre-key replenishment endpoint (backend)
  └── 2.3 X3DH initiator/responder (frontend)

Phase 3 (Double Ratchet)   [~3-4 days]
  ├── 3.1 Ratchet encrypt/decrypt
  ├── 3.2 Session state persistence
  ├── 3.3 Out-of-order message handling
  └── 3.4 Integrate with send/receive flows

Phase 4 (Sender Keys)      [~2-3 days]
  ├── 4.1 Sender Key generation & distribution
  ├── 4.2 Group encrypt/decrypt
  └── 4.3 Member add/remove handling

Phase 5 (Session Mgmt)     [~2-3 days]
  ├── 5.1 Multi-device support
  ├── 5.2 Pre-key lifecycle
  ├── 5.3 Safety numbers & identity verification UI
  └── 5.4 Key backup (WhatsApp-style)

Phase 6 (Backend Cleanup)  [~1-2 days]
  ├── 6.1 Message model cleanup
  ├── 6.2 Device model update
  └── 6.3 Remove all plaintext paths
```

---

## Open Questions

| # | Question | Options |
|---|----------|---------|
| 1 | **Library vs primitives?** | `libsignal-protocol-typescript` (faster to implement, proven) vs `@noble/*` (more control, audited crypto) |
| 2 | **Key backup?** | WhatsApp-style PIN-encrypted cloud backup vs no backup (Signal-style — reinstall = lose history) |
| 3 | **Multi-device from day 1?** | Yes (WhatsApp supports it) vs single-device first then add later |
| 4 | **SQLite for session storage?** | Sessions can be large — SQLite is better than AsyncStorage for queries. Already have `react-native-sqlite-storage` in deps |
| 5 | **Group size limit?** | Sender Key distribution scales O(n). WhatsApp caps at 1024. What's our limit? |
| 6 | **P2P calls encryption?** | Should voice/video calls use Signal Protocol for key negotiation, or handle separately? |

# Meadowtale Firestore Security Specification

## 1. Data Invariants
1. **Strict Parent Isolation**: Every document under `/users/{userId}` and its subcollections (`children`, `stories`, `readingLogs`) is accessible exclusively by the authenticated owner whose `request.auth.uid == userId` and `email_verified == true`.
2. **Master Gate Relational Integrity**: Subcollection documents (`children`, `stories`, `readingLogs`) can only be created or updated when the parent `/users/{userId}` document exists and `ownerId == request.auth.uid`.
3. **Referential Integrity on Reading Logs**: A `readingLog` entry can only be created for an existing `childId` under `/users/{userId}/children/{childId}`. Reading logs are immutable once created (`allow update: if false`).
4. **No Shadow Fields & Bounded Sizes**: Every `create` verifies `keys().hasAll(...) && keys().hasOnly(...)`; every `update` validates `isValid[Entity](incoming())`, verifies immutable fields (`uid`, `ownerId`, `createdAt`), enforces `updatedAt == request.time`, and constrains `affectedKeys().hasOnly(...)`.
5. **No PII Leakage**: User account documents omit sensitive PII such as email addresses or phone numbers and remain strictly owner-only.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Cross-User Read (`GET /users/victimUid`)**: Attacker authenticated as `attackerUid` tries to read `victimUid`'s account -> `PERMISSION_DENIED`.
2. **Cross-User Subcollection List (`LIST /users/victimUid/stories`)**: Attacker attempts to list another parent's scanned stories -> `PERMISSION_DENIED`.
3. **Unverified Email Write**: User with `email_verified: false` tries to create `/users/{uid}` -> `PERMISSION_DENIED`.
4. **Owner Spoofing on Create**: User creates a child profile under `/users/{uid}/children/c1` with `ownerId: "otherUid"` -> `PERMISSION_DENIED`.
5. **Shadow Field Injection on Create**: User creates `/users/{uid}` with extra ghost field `isAdmin: true` -> `PERMISSION_DENIED`.
6. **Shadow Field Injection on Update**: User updates bedtime settings with extra ghost field `unlimitedQuota: true` -> `PERMISSION_DENIED`.
7. **Immutable Timestamp Tampering**: User creates a story with backdated client timestamp instead of `request.time` -> `PERMISSION_DENIED`.
8. **Immutable Field Mutation**: User updates a child profile attempting to change `createdAt` or `ownerId` -> `PERMISSION_DENIED`.
9. **Resource Poisoning via Oversized ID**: User attempts to write to `/users/{uid}/stories/{150-char-id}` -> `PERMISSION_DENIED`.
10. **Value Poisoning via Oversized String / Array**: User writes a story with `title.size() > 120` or `pages.size() > 12` -> `PERMISSION_DENIED`.
11. **Orphaned Reading Log**: User attempts to create a reading log referencing a non-existent `childId` -> `PERMISSION_DENIED`.
12. **Terminal Immutability Violation**: User attempts to `update` an already-completed reading log -> `PERMISSION_DENIED`.

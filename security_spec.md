# Meadowtale Firestore Security Specification

## 1. Data Invariants
1. **Strict Parent Isolation**: Every document under `/users/{userId}` and its subcollections (`children`, `stories`, `media`, `readingLogs`) is accessible exclusively by the authenticated owner whose `request.auth.uid == userId` and `email_verified == true`.
2. **Master Gate Relational Integrity**: Subcollection documents (`children`, `stories`, `media`, `readingLogs`) can only be created or updated when the parent `/users/{userId}` document exists and `ownerId == request.auth.uid`.
3. **Referential Integrity on Reading Logs**: A `readingLog` entry can only be created for an existing `childId` under `/users/{userId}/children/{childId}`. Reading logs are immutable once created (`allow update: if false`).
4. **No Shadow Fields & Bounded Sizes**: Every `create` verifies `keys().hasAll(...) && keys().hasOnly(...)`; every `update` validates `isValid[Entity](incoming())`, verifies immutable fields (`uid`, `ownerId`, `storyId`, `createdAt`), enforces `updatedAt == request.time`, and constrains `affectedKeys().hasOnly(...)`.
5. **Bounded Media Payloads & Zero List Exposure**: `/users/{userId}/media/{mediaId}` and `/publishedMedia/{mediaId}` strictly allow only validated raster image data URLs (`jpeg`/`png`/`webp`) up to 700,000 characters, disallow `list` queries (`allow list: if false`), and enforce `isValidId(mediaId)` on `get`, `create`, `update`, and `delete`.
6. **Verified Admin-Only Main-Site Publishing**: Only verified admin accounts (`email_verified == true` and matching bootstrapped admin email or `/admins/{uid}` document) can create, update, or delete `/publishedStories/{storyId}` and `/publishedMedia/{mediaId}`. Public visitors can only read stories where `resource.data.status == 'published'`. Clients can never write to `/admins/{userId}`.
7. **No PII Leakage**: User account and published story documents omit sensitive PII such as email addresses or phone numbers.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Cross-User Read (`GET /users/victimUid`)**: Attacker authenticated as `attackerUid` tries to read `victimUid`'s account or `/users/victimUid/media/{mediaId}` -> `PERMISSION_DENIED`.
2. **Cross-User Subcollection List (`LIST /users/victimUid/stories` or `LIST /users/{uid}/media`)**: Attacker attempts to list another parent's stories or scrape media documents -> `PERMISSION_DENIED`.
3. **Unverified Email Write / Spoofed Admin Email**: User with `email_verified: false` (even with admin email) tries to create `/users/{uid}` or `/publishedStories/{storyId}` -> `PERMISSION_DENIED`.
4. **Non-Admin Main-Site Publish / Self-Assigned Admin**: Non-admin user attempts to write to `/publishedStories/{storyId}`, `/publishedMedia/{mediaId}`, or `/admins/{uid}` -> `PERMISSION_DENIED`.
5. **Shadow Field Injection on Create**: User creates `/users/{uid}`, `/users/{uid}/media/{mediaId}`, or `/publishedStories/{storyId}` with extra ghost field `isAdmin: true` -> `PERMISSION_DENIED`.
6. **Shadow Field Injection on Update**: User updates bedtime settings or published story with extra ghost field `unlimitedQuota: true` -> `PERMISSION_DENIED`.
7. **Immutable Timestamp Tampering**: User creates a story, media doc, or published story with backdated client timestamp instead of `request.time` -> `PERMISSION_DENIED`.
8. **Immutable Field Mutation**: User updates a child profile, media doc, or published story attempting to change `createdAt`, `publishedAt`, `ownerId`, `publishedBy`, or `storyId` -> `PERMISSION_DENIED`.
9. **Resource Poisoning via Oversized ID**: User attempts to write to `/users/{uid}/stories/{150-char-id}` or `/publishedStories/{150-char-id}` -> `PERMISSION_DENIED`.
10. **Value Poisoning via Oversized String / Non-Image Media**: User writes a story with `title.size() > 120`, `pages.size() > 12`, or a media doc with `data:text/html` or `dataUrl.size() > 700000` -> `PERMISSION_DENIED`.
11. **Orphaned Reading Log**: User attempts to create a reading log referencing a non-existent `childId` -> `PERMISSION_DENIED`.
12. **Terminal Immutability Violation**: User attempts to `update` an already-completed reading log -> `PERMISSION_DENIED`.

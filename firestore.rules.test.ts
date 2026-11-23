/**
 * Security Rules Specification Verification Suite (Dirty Dozen Test Matrix)
 * Mirrors the invariants documented in security_spec.md for Meadowtale.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  actorUid: string | null;
  emailVerified: boolean;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Cross-user account read blocked',
    operation: 'get',
    path: '/users/parent_victim',
    actorUid: 'parent_attacker',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-user story list blocked',
    operation: 'list',
    path: '/users/parent_victim/stories',
    actorUid: 'parent_attacker',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Unverified email account write blocked',
    operation: 'create',
    path: '/users/parent_unverified',
    actorUid: 'parent_unverified',
    emailVerified: false,
    payload: { uid: 'parent_unverified', displayName: 'Parent' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Owner spoofing on child profile create blocked',
    operation: 'create',
    path: '/users/parent_a/children/child_1',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { ownerId: 'parent_b', name: 'Leo', ageGroup: '2-3', avatar: 'duck' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow field injection on account create blocked',
    operation: 'create',
    path: '/users/parent_a',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { uid: 'parent_a', displayName: 'Parent A', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow field injection on bedtime settings update blocked',
    operation: 'update',
    path: '/users/parent_a',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { bedtimeEnabled: true, unlimitedQuota: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Client-supplied backdated timestamp blocked',
    operation: 'create',
    path: '/users/parent_a/stories/story_1',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { ownerId: 'parent_a', title: 'Test', createdAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immutable ownerId mutation on update blocked',
    operation: 'update',
    path: '/users/parent_a/children/child_1',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { ownerId: 'parent_b', name: 'Renamed' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Oversized document ID poisoning blocked',
    operation: 'create',
    path: `/users/parent_a/stories/${'x'.repeat(150)}`,
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { ownerId: 'parent_a', title: 'Valid Title' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Value poisoning with oversized pages array blocked',
    operation: 'create',
    path: '/users/parent_a/stories/story_big',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { ownerId: 'parent_a', title: 'Big', pages: new Array(15).fill({ text: 'a' }) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Orphaned reading log without existing child blocked',
    operation: 'create',
    path: '/users/parent_a/readingLogs/log_1',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { ownerId: 'parent_a', childId: 'nonexistent_child', storyId: 'pip-duck' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Mutation of immutable completed reading log blocked',
    operation: 'update',
    path: '/users/parent_a/readingLogs/log_1',
    actorUid: 'parent_a',
    emailVerified: true,
    payload: { durationSeconds: 999 },
    expected: 'PERMISSION_DENIED',
  },
];

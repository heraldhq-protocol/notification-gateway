import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ScopeGuard, RequiredScopes, SCOPES_KEY } from './scope.guard';

function createMockContext(protocol: any): ExecutionContext {
  const request = { protocol };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

describe('ScopeGuard', () => {
  let guard: ScopeGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ScopeGuard(reflector);
  });

  it('should allow when no scopes are required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const ctx = createMockContext({ scopes: ['notify:write'] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow when protocol has all required scopes', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['notify:write']);
    const ctx = createMockContext({
      scopes: ['notify:write', 'webhook:manage'],
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny when protocol is missing required scopes', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['webhook:manage']);
    const ctx = createMockContext({ scopes: ['notify:write'] });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should deny when protocol has no scopes', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['notify:write']);
    const ctx = createMockContext({ scopes: [] });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

describe('RequiredScopes decorator', () => {
  it('should set metadata with provided scopes', () => {
    const decorator = RequiredScopes('notify:write', 'webhook:manage');
    const target = {};
    decorator(
      target,
      'testMethod',
      Object.getOwnPropertyDescriptor({}, 'testMethod')!,
    );

    const reflector = new Reflector();
    // The decorator sets metadata on the descriptor
    expect(Reflect.getMetadata(SCOPES_KEY, target)).toEqual([
      'notify:write',
      'webhook:manage',
    ]);
  });
});

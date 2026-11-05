import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { CognitoProps } from '../components/RuntimeConfig';

export interface AuthUser {
  id_token: string;
  access_token: string;
  profile: Record<string, any>;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: Error | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  challenge: null | 'NEW_PASSWORD_REQUIRED';
  completeNewPassword: (
    newPassword: string,
    attributes?: Record<string, string>,
  ) => Promise<void>;
  // compat shims so existing react-oidc-context consumers keep working:
  signinRedirect: () => void;
  signoutRedirect: (args?: unknown) => Promise<void>;
  removeUser: () => Promise<void>;
  clearStaleState: () => void;
}

// ~50 minutes: Cognito access/id tokens live 60min; refresh a bit early.
const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000;

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within a CustomAuthProvider');
  }
  return ctx;
};

const userFromSession = (session: CognitoUserSession): AuthUser => ({
  id_token: session.getIdToken().getJwtToken(),
  access_token: session.getAccessToken().getJwtToken(),
  profile: session.getIdToken().decodePayload(),
});

export const CustomAuthProvider: React.FC<
  { cognitoProps: CognitoProps } & PropsWithChildren
> = ({ cognitoProps, children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [challenge, setChallenge] = useState<null | 'NEW_PASSWORD_REQUIRED'>(
    null,
  );

  // The user awaiting a NEW_PASSWORD_REQUIRED response.
  const pendingUserRef = useRef<CognitoUser | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const userPool = useMemo(
    () =>
      new CognitoUserPool({
        UserPoolId: cognitoProps.userPoolId,
        ClientId: cognitoProps.userPoolWebClientId,
      }),
    [cognitoProps.userPoolId, cognitoProps.userPoolWebClientId],
  );

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // Periodically refresh the session so long-lived tabs keep valid tokens.
  // getSession() transparently uses the refresh token when the id token expired.
  const startRefreshTimer = useCallback(() => {
    clearRefreshTimer();
    refreshTimerRef.current = setInterval(() => {
      const current = userPool.getCurrentUser();
      if (!current) return;
      current.getSession(
        (err: Error | null, session: CognitoUserSession | null) => {
          if (!err && session?.isValid()) {
            setUser(userFromSession(session));
          }
        },
      );
    }, TOKEN_REFRESH_INTERVAL_MS);
  }, [userPool, clearRefreshTimer]);

  const applySession = useCallback(
    (session: CognitoUserSession) => {
      setUser(userFromSession(session));
      setError(null);
      setChallenge(null);
      startRefreshTimer();
    },
    [startRefreshTimer],
  );

  // Restore an existing session on mount.
  useEffect(() => {
    const current = userPool.getCurrentUser();
    if (!current) {
      setIsLoading(false);
      return;
    }
    current.getSession(
      (err: Error | null, session: CognitoUserSession | null) => {
        if (!err && session?.isValid()) {
          setUser(userFromSession(session));
          startRefreshTimer();
        } else {
          setUser(null);
        }
        setIsLoading(false);
      },
    );
    return clearRefreshTimer;
  }, [userPool, startRefreshTimer, clearRefreshTimer]);

  const signIn = useCallback(
    (username: string, password: string) =>
      new Promise<void>((resolve, reject) => {
        setError(null);
        const trimmed = username.trim();

        const cognitoUser = new CognitoUser({
          Username: trimmed,
          Pool: userPool,
        });
        const details = new AuthenticationDetails({
          Username: trimmed,
          Password: password,
        });
        cognitoUser.authenticateUser(details, {
          onSuccess: (session) => {
            applySession(session);
            resolve();
          },
          onFailure: (err) => {
            setError(err);
            reject(err);
          },
          newPasswordRequired: () => {
            pendingUserRef.current = cognitoUser;
            setChallenge('NEW_PASSWORD_REQUIRED');
            resolve();
          },
        });
      }),
    [userPool, applySession],
  );

  const completeNewPassword = useCallback(
    (newPassword: string, attributes: Record<string, string> = {}) =>
      new Promise<void>((resolve, reject) => {
        const cognitoUser = pendingUserRef.current;
        if (!cognitoUser) {
          const err = new Error('No pending new-password challenge');
          setError(err);
          reject(err);
          return;
        }
        setError(null);
        cognitoUser.completeNewPasswordChallenge(
          newPassword,
          attributes,
          {
            onSuccess: (session) => {
              pendingUserRef.current = null;
              applySession(session);
              resolve();
            },
            onFailure: (err) => {
              setError(err);
              reject(err);
            },
          },
        );
      }),
    [applySession],
  );

  const signOut = useCallback(async () => {
    clearRefreshTimer();
    userPool.getCurrentUser()?.signOut();
    pendingUserRef.current = null;
    setUser(null);
    setChallenge(null);
    setError(null);
  }, [userPool, clearRefreshTimer]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: !!user,
      isLoading,
      error,
      challenge,
      signIn,
      signOut,
      completeNewPassword,
      // compat shims:
      signinRedirect: () => {},
      signoutRedirect: () => signOut(),
      removeUser: () => signOut(),
      clearStaleState: () => {},
    }),
    [
      user,
      isLoading,
      error,
      challenge,
      signIn,
      signOut,
      completeNewPassword,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// Minimal context for serve-local mode without cognitoProps: consumers can call
// useAuth() without a User Pool being configured (login is skipped).
const stubValue: AuthContextValue = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  challenge: null,
  signIn: async () => {},
  signOut: async () => {},
  completeNewPassword: async () => {},
  signinRedirect: () => {},
  signoutRedirect: async () => {},
  removeUser: async () => {},
  clearStaleState: () => {},
};

export const StubAuthProvider: React.FC<PropsWithChildren> = ({ children }) => (
  <AuthContext.Provider value={stubValue}>{children}</AuthContext.Provider>
);

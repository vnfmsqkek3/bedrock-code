import React, { PropsWithChildren } from 'react';
import { CustomAuthProvider, StubAuthProvider, useAuth } from '../../auth';
import { Alert } from '../Alert';
import CubeLoader from '../CubeLoader';
import LoginForm from '../LoginForm';
import { useRuntimeConfig } from '../../hooks/useRuntimeConfig';
import Config from '../../config';

/**
 * Sets up the Cognito auth using a custom in-app login form (SRP via
 * amazon-cognito-identity-js) instead of the Cognito Hosted UI redirect.
 *
 * This assumes a runtime-config.json file is present at '/'. In order for Auth to be set up automatically,
 * the runtime-config.json must have the cognitoProps set.
 */
const CognitoAuth: React.FC<PropsWithChildren> = ({ children }) => {
  const { cognitoProps } = useRuntimeConfig();

  if (!cognitoProps) {
    if (import.meta.env.MODE === 'serve-local') {
      // In serve-local mode with no cognitoProps available, we skip login.
      return <StubAuthProvider>{children}</StubAuthProvider>;
    }
    return (
      <Alert type="error" header="Runtime config configuration error">
        <p>
          The cognitoProps have not been configured in the runtime-config.json.
        </p>
      </Alert>
    );
  }

  return (
    <CustomAuthProvider cognitoProps={cognitoProps}>
      <CognitoAuthInternal>{children}</CognitoAuthInternal>
    </CustomAuthProvider>
  );
};

const CognitoAuthInternal: React.FC<PropsWithChildren> = ({ children }) => {
  const auth = useAuth();

  if (auth.isLoading) {
    // Branded splash while restoring an existing session.
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-8 bg-[#faf9fb] dark:bg-slate-950">
        <div className="flex flex-col items-center gap-3">
          <span className="text-[15px] font-semibold tracking-tight text-[#1a1523] dark:text-slate-100">
            {Config.applicationName}
          </span>
        </div>
        <CubeLoader />
      </div>
    );
  }

  if (auth.isAuthenticated) {
    return children;
  }

  return <LoginForm />;
};

export default CognitoAuth;

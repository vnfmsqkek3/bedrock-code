import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth';
import Config from '../../config';

const Spinner = () => (
  <svg
    className="w-4 h-4 animate-spin"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
    />
  </svg>
);

const inputClass =
  'w-full px-3 py-2.5 text-sm bg-white border border-[#e4dfec] rounded-lg text-[#1a1523] placeholder-[#a89fb8] focus:outline-none focus:border-[#a78bfa] transition-colors';
const labelClass =
  'block text-xs font-medium text-[#3a3350] mb-1.5';

const LoginForm = () => {
  const { t } = useTranslation();
  const { signIn, completeNewPassword, challenge, error } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const mapError = (err: Error): string => {
    switch (err.name) {
      case 'NotAuthorizedException':
      case 'UserNotFoundException':
        return t('auth.errorInvalidCredentials');
      default:
        return err.message || t('auth.errorGeneric');
    }
  };

  const displayError =
    localError ?? (error ? mapError(error) : null);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setLocalError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch {
      // error surfaced via auth.error
    } finally {
      setSubmitting(false);
    }
  };

  const handleNewPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setLocalError(null);
    if (!newPassword) {
      setLocalError(t('auth.errorGeneric'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError(t('auth.errorPasswordMismatch'));
      return;
    }
    if (!givenName.trim() || !familyName.trim()) {
      setLocalError(t('auth.errorNameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await completeNewPassword(newPassword, {
        given_name: givenName.trim(),
        family_name: familyName.trim(),
      });
    } catch {
      // error surfaced via auth.error
    } finally {
      setSubmitting(false);
    }
  };

  const isNewPassword = challenge === 'NEW_PASSWORD_REQUIRED';

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#faf9fb] p-4">
      <div
        className="w-full max-w-[400px] bg-white border border-[#ece9f0] rounded-[14px] p-7"
        style={{ boxShadow: '0 1px 3px rgba(26,21,35,.05)' }}
      >
        {/* Header */}
        <div className="flex flex-col items-center gap-3 mb-7">
          <span className="text-[15px] font-semibold tracking-tight text-[#1a1523]">
            {Config.applicationName}
          </span>
          <span className="text-[13px] text-[#6b6478]">
            {isNewPassword ? t('auth.newPasswordTitle') : t('auth.subtitle')}
          </span>
        </div>

        {displayError && (
          <div className="mb-4 px-3 py-2.5 text-[13px] rounded-lg bg-[#fdeceb] text-[#c0392b] border border-[#f0c8c8]">
            {displayError}
          </div>
        )}

        {isNewPassword ? (
          <form onSubmit={handleNewPassword} className="flex flex-col gap-4">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className={labelClass} htmlFor="family-name">
                  {t('auth.familyName')}
                </label>
                <input
                  id="family-name"
                  type="text"
                  autoComplete="family-name"
                  className={inputClass}
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <label className={labelClass} htmlFor="given-name">
                  {t('auth.givenName')}
                </label>
                <input
                  id="given-name"
                  type="text"
                  autoComplete="given-name"
                  className={inputClass}
                  value={givenName}
                  onChange={(e) => setGivenName(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor="new-password">
                {t('auth.newPassword')}
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                className={inputClass}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="confirm-password">
                {t('auth.confirmPassword')}
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                className={inputClass}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <SubmitButton
              submitting={submitting}
              label={t('auth.setPassword')}
              busyLabel={t('auth.signingIn')}
            />
          </form>
        ) : (
          <form onSubmit={handleSignIn} className="flex flex-col gap-4">
            <div>
              <label className={labelClass} htmlFor="email">
                {t('auth.email')}
              </label>
              <input
                id="email"
                type="text"
                autoComplete="username"
                autoFocus
                className={inputClass}
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="password">
                {t('auth.password')}
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <SubmitButton
              submitting={submitting}
              label={t('auth.signIn')}
              busyLabel={t('auth.signingIn')}
            />
          </form>
        )}
      </div>
    </div>
  );
};

const SubmitButton = ({
  submitting,
  label,
  busyLabel,
}: {
  submitting: boolean;
  label: string;
  busyLabel: string;
}) => (
  <button
    type="submit"
    disabled={submitting}
    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[9px] text-sm font-medium text-white bg-[#7c3aed] hover:bg-[#6d28d9] disabled:bg-[#e9e5f0] disabled:text-[#a89fb8] transition-colors"
  >
    {submitting && <Spinner />}
    {submitting ? busyLabel : label}
  </button>
);

export default LoginForm;

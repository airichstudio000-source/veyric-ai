import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth';
import { AlertCircle, Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import { playClickSound } from '../lib/sound';
import { GlassBrandLogo } from './GlassBrandLogo';

type AuthMode = 'signin' | 'signup';
type SubmittingMethod = 'email' | 'google' | null;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mapFirebaseAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password. Please check your details and try again.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact support.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in instead.';
    case 'auth/weak-password':
      return 'Password is too weak. Please use at least 6 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment before trying again.';
    case 'auth/network-request-failed':
      return 'Network connection error. Please check your internet and try again.';
    case 'auth/popup-closed-by-user':
      return 'Google sign-in was cancelled before completing.';
    case 'auth/popup-blocked':
      return 'The sign-in popup was blocked by your browser. Please allow popups and try again.';
    case 'auth/cancelled-popup-request':
      return 'Sign-in request was interrupted. Please try again.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with the same email using a different sign-in method.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled yet in Firebase Console Authentication.';
    case 'auth/unauthorized-domain':
      return 'This app domain is not authorized yet in Firebase Console Authentication settings.';
    default:
      return 'Unable to complete authentication right now. Please try again.';
  }
}

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<SubmittingMethod>(null);

  const isBusy = submitting !== null;

  const switchMode = (nextMode: AuthMode) => {
    if (isBusy || nextMode === mode) return;
    playClickSound();
    setMode(nextMode);
    setError(null);
    setConfirmPassword('');
  };

  const handleGoogleLogin = async () => {
    if (isBusy) return;
    playClickSound();
    setError(null);
    setSubmitting('google');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(mapFirebaseAuthError(err));
    } finally {
      setSubmitting(null);
    }
  };

  const handleEmailSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isBusy) return;
    playClickSound();

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setError('Password must be at least 6 characters long.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setError(null);
    setSubmitting('email');

    try {
      if (mode === 'signin') {
        await signInWithEmailAndPassword(auth, trimmedEmail, password);
      } else {
        await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      }
    } catch (err) {
      setError(mapFirebaseAuthError(err));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="veyric-backdrop relative flex min-h-dvh w-full items-center justify-center overflow-y-auto px-4 py-8 text-white">
      <div className="glass-panel veyric-panel-enter w-full max-w-[440px] rounded-[30px] p-6 sm:p-8">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center">
          <GlassBrandLogo size={46} className="shrink-0" />
          <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-white sm:text-[26px]">
            VEYRIC AI
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-white/85">
            {mode === 'signin'
              ? 'Sign in to continue your conversations in English or Myanmar.'
              : 'Create your VEYRIC AI account to get started.'}
          </p>
        </div>

        {/* Mode Toggle */}
        <div
          role="tablist"
          aria-label="Authentication mode"
          className="mt-6 grid grid-cols-2 gap-1 rounded-2xl border border-white/25 bg-white/[0.08] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            disabled={isBusy}
            onClick={() => switchMode('signin')}
            className={`min-h-[40px] rounded-xl px-3 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-white sm:text-sm ${
              mode === 'signin'
                ? 'border border-white/40 bg-white/[0.22] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]'
                : 'border border-transparent text-white/75 hover:text-white'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            disabled={isBusy}
            onClick={() => switchMode('signup')}
            className={`min-h-[40px] rounded-xl px-3 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-white sm:text-sm ${
              mode === 'signup'
                ? 'border border-white/40 bg-white/[0.22] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]'
                : 'border border-transparent text-white/75 hover:text-white'
            }`}
          >
            Create Account
          </button>
        </div>

        {/* Inline Error Message */}
        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-2xl border border-rose-300/40 bg-rose-500/20 px-3.5 py-2.5 text-xs leading-relaxed text-rose-50"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-200" />
            <span>{error}</span>
          </div>
        )}

        {/* Google Sign-In */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={isBusy}
          className="glass-control mt-5 flex min-h-[46px] w-full items-center justify-center gap-2.5 rounded-2xl px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-white"
        >
          {submitting === 'google' ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-white" />
              <span>Connecting to Google…</span>
            </>
          ) : (
            <>
              <svg
                className="h-4.5 w-4.5 shrink-0"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fill="#EA4335"
                  d="M12 10.2v3.9h5.5c-.24 1.25-.96 2.31-2.04 3.02l3.3 2.56c1.92-1.77 3.03-4.38 3.03-7.48 0-.71-.06-1.4-.18-2.06H12z"
                />
                <path
                  fill="#34A853"
                  d="M12 22c2.75 0 5.06-.91 6.75-2.47l-3.3-2.56c-.91.61-2.08.98-3.45.98-2.65 0-4.9-1.79-5.7-4.2H2.89v2.64A10 10 0 0 0 12 22z"
                />
                <path
                  fill="#4A90E2"
                  d="M6.3 13.75a5.98 5.98 0 0 1 0-3.5V7.61H2.89a10 10 0 0 0 0 8.78l3.41-2.64z"
                />
                <path
                  fill="#FBBC05"
                  d="M12 6.05c1.5 0 2.84.52 3.9 1.53l2.92-2.92C17.05 2.99 14.74 2 12 2A10 10 0 0 0 2.89 7.61l3.41 2.64c.8-2.41 3.05-4.2 5.7-4.2z"
                />
              </svg>
              <span>Continue with Google</span>
            </>
          )}
        </button>

        {/* Divider */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/25" />
          <span className="text-[11px] font-medium tracking-wide text-white/75 uppercase">
            or with email
          </span>
          <div className="h-px flex-1 bg-white/25" />
        </div>

        {/* Email & Password Form */}
        <form onSubmit={handleEmailSubmit} noValidate className="space-y-3.5">
          <div>
            <label
              htmlFor="auth-email"
              className="mb-1.5 block text-xs font-medium text-white/90"
            >
              Email address
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/65" />
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                disabled={isBusy}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="you@example.com"
                className="min-h-[46px] w-full rounded-2xl border border-white/30 bg-white/[0.12] pl-10 pr-4 text-sm text-white placeholder:text-white/55 transition-colors focus:border-white/65 focus:bg-white/[0.18] focus:outline-none disabled:opacity-60"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="mb-1.5 block text-xs font-medium text-white/90"
            >
              Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/65" />
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                disabled={isBusy}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={
                  mode === 'signin' ? 'Enter your password' : 'At least 6 characters'
                }
                className="min-h-[46px] w-full rounded-2xl border border-white/30 bg-white/[0.12] pl-10 pr-12 text-sm text-white placeholder:text-white/55 transition-colors focus:border-white/65 focus:bg-white/[0.18] focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  playClickSound();
                  setShowPassword((prev) => !prev);
                }}
                className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-xl text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {mode === 'signup' && (
            <div>
              <label
                htmlFor="auth-confirm-password"
                className="mb-1.5 block text-xs font-medium text-white/90"
              >
                Confirm password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/65" />
                <input
                  id="auth-confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  disabled={isBusy}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="Re-enter your password"
                  className="min-h-[46px] w-full rounded-2xl border border-white/30 bg-white/[0.12] pl-10 pr-12 text-sm text-white placeholder:text-white/55 transition-colors focus:border-white/65 focus:bg-white/[0.18] focus:outline-none disabled:opacity-60"
                />
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    playClickSound();
                    setShowConfirmPassword((prev) => !prev);
                  }}
                  className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-xl text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                  aria-label={
                    showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'
                  }
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isBusy}
            className="glass-surface mt-2 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-2xl border-white/45 bg-white/[0.22] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:border-white/65 hover:bg-white/[0.30] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-white"
          >
            {submitting === 'email' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {mode === 'signin' ? 'Signing in…' : 'Creating account…'}
                </span>
              </>
            ) : (
              <span>{mode === 'signin' ? 'Sign In' : 'Create Account'}</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

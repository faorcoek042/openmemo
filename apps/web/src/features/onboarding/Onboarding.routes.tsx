import { lazy } from 'react';
import type { RouteObject } from 'react-router';

const OnboardingPage = lazy(() => import('./OnboardingPage'));

export const onboardingRoutes: RouteObject[] = [
  { path: 'onboarding', element: <OnboardingPage /> },
];

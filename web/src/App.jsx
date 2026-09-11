import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import { SectionSkeleton } from './components/ui/Skeleton.jsx';
import RequireAuth from './components/auth/RequireAuth.jsx';

const ImagePage = lazy(() => import('./pages/ImagePage.jsx'));
const VideoPage = lazy(() => import('./pages/VideoPage.jsx'));
const ComparePage = lazy(() => import('./pages/ComparePage.jsx'));
const ReelsPage = lazy(() => import('./pages/ReelsPage.jsx'));
const ExplorePage = lazy(() => import('./pages/ExplorePage.jsx'));
const TagExplorePage = lazy(() => import('./pages/TagExplorePage.jsx'));
const LocationExplorePage = lazy(() => import('./pages/LocationExplorePage.jsx'));
const UploadPage = lazy(() => import('./pages/UploadPage.jsx'));
const AuthPage = lazy(() => import('./pages/AuthPage.jsx'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx'));
const ProfileSettingsPage = lazy(() => import('./pages/ProfileSettingsPage.jsx'));
const MessagesPage = lazy(() => import('./pages/MessagesPage.jsx'));

const PasswordResetPage = lazy(() => import('./pages/PasswordResetPage.jsx'));
const ModerationPage = lazy(() => import('./pages/ModerationPage.jsx'));
export default function App() {
  return (
    <Suspense fallback={<SectionSkeleton label="Loading page" />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/reels" replace />} />
          <Route path="/image" element={<ImagePage />} />
          <Route path="/video" element={<VideoPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/reels" element={<ReelsPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/explore/tag/:tag" element={<TagExplorePage />} />
          <Route path="/explore/location/:key" element={<LocationExplorePage />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="register" />} />
          <Route path="/forgot-password" element={<PasswordResetPage requestOnly />} />
          <Route path="/reset-password" element={<PasswordResetPage />} />
          <Route path="/profile/:username" element={<ProfilePage />} />
          <Route path="/settings/profile" element={<RequireAuth><ProfileSettingsPage /></RequireAuth>} />
          <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />
          <Route path="/messages/:conversationId" element={<RequireAuth><MessagesPage /></RequireAuth>} />
          <Route path="/upload" element={<RequireAuth><UploadPage /></RequireAuth>} />
          <Route path="/moderation" element={<RequireAuth><ModerationPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/reels" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

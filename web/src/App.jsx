import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';

const ImagePage = lazy(() => import('./pages/ImagePage.jsx'));
const VideoPage = lazy(() => import('./pages/VideoPage.jsx'));
const ComparePage = lazy(() => import('./pages/ComparePage.jsx'));
const ReelsPage = lazy(() => import('./pages/ReelsPage.jsx'));

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/image" replace />} />
          <Route path="/image" element={<ImagePage />} />
          <Route path="/video" element={<VideoPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/reels" element={<ReelsPage />} />
          <Route path="*" element={<Navigate to="/image" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
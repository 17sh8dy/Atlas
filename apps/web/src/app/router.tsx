import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { Placeholder } from '../pages/Placeholder';

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Placeholder title="Home" blurb="Featured, trending, and staff-picked wallpapers." /> },
      { path: 'search', element: <Placeholder title="Search" blurb="Instant search across tags, colors, and resolutions." /> },
      { path: 'categories', element: <Placeholder title="Categories" blurb="Nature, Space, Cars, Gaming, Anime, and more." /> },
      { path: 'library', element: <Placeholder title="Library" blurb="Favorites, collections, and download history." /> },
      { path: 'settings', element: <Placeholder title="Settings" blurb="Theme, performance, downloads, and account." /> },
    ],
  },
]);

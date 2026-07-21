import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { Home } from '../pages/Home';
import { Search } from '../pages/Search';
import { Categories } from '../pages/Categories';
import { CategoryDetail } from '../pages/CategoryDetail';
import { WallpaperDetail } from '../pages/WallpaperDetail';
import { Placeholder } from '../pages/Placeholder';

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'search', element: <Search /> },
      { path: 'categories', element: <Categories /> },
      { path: 'category/:slug', element: <CategoryDetail /> },
      { path: 'w/:id', element: <WallpaperDetail /> },
      {
        path: 'library',
        element: (
          <Placeholder
            title="Library"
            blurb="Favorites, collections, and download history — arriving in Phase 4."
          />
        ),
      },
      {
        path: 'settings',
        element: (
          <Placeholder
            title="Settings"
            blurb="Theme, performance, downloads, and account — arriving in Phase 7."
          />
        ),
      },
    ],
  },
]);

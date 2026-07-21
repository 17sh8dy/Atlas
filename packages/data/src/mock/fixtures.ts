import type { Category, Collection, Orientation, Wallpaper } from '@atlas/core';
import { orientationOf } from '@atlas/core';

/** Deterministic mock catalog. Real images via Lorem Picsum seeded URLs. */

export const categories: Category[] = [
  { id: 'c-nature', slug: 'nature', name: 'Nature', icon: 'Trees', sort: 1 },
  { id: 'c-space', slug: 'space', name: 'Space', icon: 'Rocket', sort: 2 },
  { id: 'c-cars', slug: 'cars', name: 'Cars', icon: 'Car', sort: 3 },
  { id: 'c-gaming', slug: 'gaming', name: 'Gaming', icon: 'Gamepad2', sort: 4 },
  { id: 'c-anime', slug: 'anime', name: 'Anime', icon: 'Sparkles', sort: 5 },
  { id: 'c-cities', slug: 'cities', name: 'Cities', icon: 'Building2', sort: 6 },
  { id: 'c-minimal', slug: 'minimal', name: 'Minimal', icon: 'Shapes', sort: 7 },
  { id: 'c-abstract', slug: 'abstract', name: 'Abstract', icon: 'Palette', sort: 8 },
  { id: 'c-animals', slug: 'animals', name: 'Animals', icon: 'PawPrint', sort: 9 },
  { id: 'c-technology', slug: 'technology', name: 'Technology', icon: 'Cpu', sort: 10 },
  { id: 'c-architecture', slug: 'architecture', name: 'Architecture', icon: 'Landmark', sort: 11 },
  { id: 'c-fantasy', slug: 'fantasy', name: 'Fantasy', icon: 'Castle', sort: 12 },
];

interface Spec {
  id: string;
  title: string;
  category: string;
  author: string;
  ratio: Orientation;
  color: string;
  colors: string[];
  tags: string[];
  popularity: number;
  day: number;
  featured?: boolean;
  staff?: boolean;
  ai?: boolean;
}

const DIMS: Record<Orientation, { w: number; h: number }> = {
  landscape: { w: 3840, h: 2160 },
  portrait: { w: 1440, h: 2560 },
  square: { w: 2160, h: 2160 },
};

function build(spec: Spec): Wallpaper {
  const { w, h } = DIMS[spec.ratio];
  const url = (width: number) =>
    `https://picsum.photos/seed/${spec.id}/${width}/${Math.round((width * h) / w)}`;
  const day = ((spec.day - 1) % 28) + 1;
  return {
    id: spec.id,
    title: spec.title,
    source: spec.ai ? 'ai' : 'unsplash',
    sourceId: spec.id,
    sourceUrl: `https://picsum.photos/seed/${spec.id}`,
    author: spec.author,
    license: 'Mock / demo',
    attribution: `Photo by ${spec.author}`,
    width: w,
    height: h,
    orientation: orientationOf(w, h),
    dominantColor: spec.color,
    colors: spec.colors,
    tags: spec.tags,
    categorySlugs: [spec.category],
    isAi: spec.ai ?? false,
    isLive: false,
    assets: [
      { kind: 'thumb', url: url(600), width: 600, height: Math.round((600 * h) / w) },
      { kind: 'preview', url: url(1280), width: 1280, height: Math.round((1280 * h) / w) },
      { kind: 'full', url: url(Math.min(w, 2560)), width: w, height: h },
    ],
    popularity: spec.popularity,
    createdAt: `2026-07-${String(day).padStart(2, '0')}T10:00:00Z`,
  };
}

const SPECS: Spec[] = [
  // Nature
  { id: 'nature-01', title: 'Alpine Dawn', category: 'nature', author: 'Ansel M.', ratio: 'landscape', color: '#3b5b52', colors: ['#3b5b52', '#8fb9a8', '#f2e9d8'], tags: ['mountains', 'fog', 'sunrise'], popularity: 982, day: 26, featured: true },
  { id: 'nature-02', title: 'Emerald Canopy', category: 'nature', author: 'Rae F.', ratio: 'portrait', color: '#1f3d2b', colors: ['#1f3d2b', '#4e7d4e'], tags: ['forest', 'green'], popularity: 640, day: 22 },
  { id: 'nature-03', title: 'Glacier Lake', category: 'nature', author: 'Ivo K.', ratio: 'landscape', color: '#2a4d63', colors: ['#2a4d63', '#7fb2c9'], tags: ['lake', 'reflection'], popularity: 811, day: 19, staff: true },
  // Space
  { id: 'space-01', title: 'Orion Deep Field', category: 'space', author: 'Nova Labs', ratio: 'landscape', color: '#10121f', colors: ['#10121f', '#3a2f6b', '#a76bff'], tags: ['galaxy', 'stars', 'nebula'], popularity: 1240, day: 27, featured: true, staff: true },
  { id: 'space-02', title: 'Lunar Terminator', category: 'space', author: 'Nova Labs', ratio: 'square', color: '#0c0c10', colors: ['#0c0c10', '#c9c9d6'], tags: ['moon', 'monochrome'], popularity: 705, day: 20 },
  { id: 'space-03', title: 'Aurora Orbit', category: 'space', author: 'Sena P.', ratio: 'portrait', color: '#062b2b', colors: ['#062b2b', '#22d3aa'], tags: ['aurora', 'earth'], popularity: 903, day: 24, ai: true },
  // Cars
  { id: 'cars-01', title: 'Midnight GT', category: 'cars', author: 'Drive Co.', ratio: 'landscape', color: '#15161a', colors: ['#15161a', '#e23b3b'], tags: ['supercar', 'night'], popularity: 1090, day: 25, featured: true },
  { id: 'cars-02', title: 'Coastal Roadster', category: 'cars', author: 'Drive Co.', ratio: 'landscape', color: '#284b63', colors: ['#284b63', '#f4a261'], tags: ['classic', 'coast'], popularity: 588, day: 18 },
  { id: 'cars-03', title: 'Neon Pit Lane', category: 'cars', author: 'Kaz T.', ratio: 'portrait', color: '#1a1030', colors: ['#1a1030', '#ff5cc8'], tags: ['racing', 'neon'], popularity: 762, day: 21, staff: true },
  // Gaming
  { id: 'gaming-01', title: 'Cyber District', category: 'gaming', author: 'Pixel Forge', ratio: 'landscape', color: '#0d1030', colors: ['#0d1030', '#4f6bff', '#ff5cc8'], tags: ['cyberpunk', 'city'], popularity: 1320, day: 27, featured: true, staff: true },
  { id: 'gaming-02', title: 'Last Save Point', category: 'gaming', author: 'Pixel Forge', ratio: 'portrait', color: '#241a2e', colors: ['#241a2e', '#b06bff'], tags: ['rpg', 'atmosphere'], popularity: 690, day: 23 },
  { id: 'gaming-03', title: 'Arena Zero', category: 'gaming', author: 'Mira V.', ratio: 'landscape', color: '#101c14', colors: ['#101c14', '#3ddc84'], tags: ['esports', 'stadium'], popularity: 845, day: 17 },
  // Anime
  { id: 'anime-01', title: 'Rooftop Rain', category: 'anime', author: 'Studio Kumo', ratio: 'portrait', color: '#1b2740', colors: ['#1b2740', '#7aa2ff'], tags: ['city', 'rain', 'mood'], popularity: 1150, day: 26, featured: true },
  { id: 'anime-02', title: 'Sakura Line', category: 'anime', author: 'Studio Kumo', ratio: 'landscape', color: '#3a1f2e', colors: ['#3a1f2e', '#ff9ec7'], tags: ['spring', 'train'], popularity: 970, day: 22, staff: true },
  { id: 'anime-03', title: 'Neon Alley', category: 'anime', author: 'Ren H.', ratio: 'portrait', color: '#160f24', colors: ['#160f24', '#c86bff'], tags: ['night', 'street'], popularity: 733, day: 19 },
  // Cities
  { id: 'cities-01', title: 'Harbor Lights', category: 'cities', author: 'Urbanist', ratio: 'landscape', color: '#0f1c2e', colors: ['#0f1c2e', '#ffca7a'], tags: ['skyline', 'night', 'water'], popularity: 1010, day: 25, featured: true },
  { id: 'cities-02', title: 'Metro Rush', category: 'cities', author: 'Urbanist', ratio: 'landscape', color: '#1a1a1f', colors: ['#1a1a1f', '#ff6b3d'], tags: ['motion', 'street'], popularity: 620, day: 16 },
  { id: 'cities-03', title: 'Glass Towers', category: 'cities', author: 'Lena D.', ratio: 'portrait', color: '#20323f', colors: ['#20323f', '#9fd8e0'], tags: ['architecture', 'blue'], popularity: 588, day: 20 },
  // Minimal
  { id: 'minimal-01', title: 'Soft Gradient', category: 'minimal', author: 'Studio Null', ratio: 'landscape', color: '#2b2540', colors: ['#2b2540', '#8f7bff'], tags: ['gradient', 'calm'], popularity: 880, day: 24, staff: true },
  { id: 'minimal-02', title: 'Dune Curve', category: 'minimal', author: 'Studio Null', ratio: 'portrait', color: '#caa477', colors: ['#caa477', '#f0e0c8'], tags: ['sand', 'curve'], popularity: 512, day: 15 },
  { id: 'minimal-03', title: 'Paper Fold', category: 'minimal', author: 'Aki O.', ratio: 'square', color: '#e7e4dd', colors: ['#e7e4dd', '#b9b4a8'], tags: ['light', 'texture'], popularity: 470, day: 18 },
  // Abstract
  { id: 'abstract-01', title: 'Fluid Bloom', category: 'abstract', author: 'Chroma', ratio: 'landscape', color: '#2a0f3a', colors: ['#2a0f3a', '#ff5cc8', '#5cc8ff'], tags: ['liquid', 'color'], popularity: 1005, day: 26, featured: true, ai: true },
  { id: 'abstract-02', title: 'Iridescent Waves', category: 'abstract', author: 'Chroma', ratio: 'portrait', color: '#0f2a3a', colors: ['#0f2a3a', '#22d3ee'], tags: ['waves', 'holographic'], popularity: 726, day: 21 },
  { id: 'abstract-03', title: 'Grain Field', category: 'abstract', author: 'Odo R.', ratio: 'landscape', color: '#2e2a24', colors: ['#2e2a24', '#e0a35c'], tags: ['noise', 'warm'], popularity: 540, day: 14 },
  // Animals
  { id: 'animals-01', title: 'Arctic Fox', category: 'animals', author: 'Wildframe', ratio: 'portrait', color: '#3a4655', colors: ['#3a4655', '#e8eef2'], tags: ['fox', 'snow'], popularity: 934, day: 23, staff: true },
  { id: 'animals-02', title: 'Coral Reef', category: 'animals', author: 'Wildframe', ratio: 'landscape', color: '#0d3b45', colors: ['#0d3b45', '#ffb347'], tags: ['ocean', 'fish'], popularity: 690, day: 17 },
  { id: 'animals-03', title: 'Savanna Watch', category: 'animals', author: 'Tomas L.', ratio: 'landscape', color: '#5a4326', colors: ['#5a4326', '#e9c46a'], tags: ['lion', 'golden'], popularity: 610, day: 13 },
  // Technology
  { id: 'technology-01', title: 'Silicon Macro', category: 'technology', author: 'Circuit', ratio: 'landscape', color: '#101820', colors: ['#101820', '#39c0ed'], tags: ['chip', 'macro'], popularity: 820, day: 22 },
  { id: 'technology-02', title: 'Data Streams', category: 'technology', author: 'Circuit', ratio: 'portrait', color: '#04121a', colors: ['#04121a', '#00e5a0'], tags: ['code', 'green'], popularity: 705, day: 19, ai: true },
  { id: 'technology-03', title: 'Server Glow', category: 'technology', author: 'Priya N.', ratio: 'landscape', color: '#1a1020', colors: ['#1a1020', '#8f5cff'], tags: ['datacenter', 'violet'], popularity: 560, day: 12 },
  // Architecture
  { id: 'architecture-01', title: 'Concrete Arc', category: 'architecture', author: 'Formwork', ratio: 'portrait', color: '#2c2c30', colors: ['#2c2c30', '#c8c4bc'], tags: ['brutalist', 'curve'], popularity: 760, day: 21, staff: true },
  { id: 'architecture-02', title: 'Atrium Light', category: 'architecture', author: 'Formwork', ratio: 'landscape', color: '#26303a', colors: ['#26303a', '#e8d9b5'], tags: ['interior', 'glass'], popularity: 640, day: 16 },
  { id: 'architecture-03', title: 'Desert House', category: 'architecture', author: 'Sol A.', ratio: 'landscape', color: '#7a5a44', colors: ['#7a5a44', '#f0cfa8'], tags: ['modern', 'warm'], popularity: 588, day: 11 },
  // Fantasy
  { id: 'fantasy-01', title: 'Floating Isles', category: 'fantasy', author: 'Mythos', ratio: 'landscape', color: '#173047', colors: ['#173047', '#7ad0ff', '#ffd97a'], tags: ['epic', 'sky'], popularity: 1180, day: 27, featured: true, ai: true },
  { id: 'fantasy-02', title: 'Ember Keep', category: 'fantasy', author: 'Mythos', ratio: 'portrait', color: '#2e1410', colors: ['#2e1410', '#ff7a3d'], tags: ['castle', 'fire'], popularity: 870, day: 23, staff: true },
  { id: 'fantasy-03', title: 'Moonlit Grove', category: 'fantasy', author: 'Wynn E.', ratio: 'landscape', color: '#101a2e', colors: ['#101a2e', '#7affce'], tags: ['forest', 'magic'], popularity: 742, day: 18 },
];

export const wallpapers: Wallpaper[] = SPECS.map(build);

const staffIds = new Set(SPECS.filter((s) => s.staff).map((s) => s.id));
const featuredIds = new Set(SPECS.filter((s) => s.featured).map((s) => s.id));

export const featuredWallpaperIds: string[] = [...featuredIds];
export const staffPickIds: string[] = [...staffIds];

export const collections: Collection[] = [
  {
    id: 'col-nightfall',
    title: 'Nightfall',
    description: 'Deep, moody wallpapers for after dark.',
    coverUrl: wallpapers.find((w) => w.id === 'cities-01')?.assets[1]?.url,
    isFeatured: true,
    isStaffPick: true,
    wallpaperIds: ['cities-01', 'anime-03', 'space-01', 'gaming-01', 'fantasy-03'],
  },
  {
    id: 'col-minimal-focus',
    title: 'Minimal Focus',
    description: 'Calm, clean backdrops that stay out of the way.',
    coverUrl: wallpapers.find((w) => w.id === 'minimal-01')?.assets[1]?.url,
    isFeatured: true,
    isStaffPick: false,
    wallpaperIds: ['minimal-01', 'minimal-02', 'minimal-03', 'abstract-03'],
  },
  {
    id: 'col-wanderlust',
    title: 'Wanderlust',
    description: 'Landscapes that make you want to pack a bag.',
    coverUrl: wallpapers.find((w) => w.id === 'nature-01')?.assets[1]?.url,
    isFeatured: true,
    isStaffPick: false,
    wallpaperIds: ['nature-01', 'nature-03', 'animals-03', 'architecture-03'],
  },
  {
    id: 'col-synthwave',
    title: 'Synthwave',
    description: 'Neon, chrome, and endless horizons.',
    coverUrl: wallpapers.find((w) => w.id === 'cars-03')?.assets[1]?.url,
    isFeatured: false,
    isStaffPick: true,
    wallpaperIds: ['cars-03', 'gaming-01', 'abstract-01', 'technology-03'],
  },
];

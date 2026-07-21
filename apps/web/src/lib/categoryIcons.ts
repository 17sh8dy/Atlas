import { Icons } from '@atlas/ui';

const MAP: Record<string, Icons.LucideIcon> = {
  nature: Icons.Trees,
  space: Icons.Rocket,
  cars: Icons.Car,
  gaming: Icons.Gamepad2,
  anime: Icons.Sparkles,
  cities: Icons.Building2,
  minimal: Icons.Shapes,
  abstract: Icons.Palette,
  animals: Icons.PawPrint,
  technology: Icons.Cpu,
  architecture: Icons.Landmark,
  fantasy: Icons.Castle,
};

export function categoryIcon(slug: string): Icons.LucideIcon {
  return MAP[slug] ?? Icons.Compass;
}

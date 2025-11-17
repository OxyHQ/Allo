/**
 * Navigation-related type definitions
 */

export interface NavigationItem {
  title: string;
  icon: React.ReactNode;
  iconActive: React.ReactNode;
  route: string;
  onPress?: () => void;
}

export interface NavigationItemConfig {
  title: string;
  route: string;
  getIcon: (isActive: boolean) => React.ReactNode;
  onPress?: () => void;
}


# Architecture & Best Practices

This document outlines the architecture and best practices followed in this Expo Router 54 application.

## Expo Router 54 Best Practices

### 1. File-Based Routing
- Routes are defined by the file system structure
- Use route groups `(chat)` for organization without affecting URLs
- Dynamic routes use `[id].tsx` syntax
- Nested routes are created through folder structure
- Expo Router automatically discovers routes from file system

### 2. Code Splitting & Performance
- **React.lazy()** for dynamic imports of heavy components
- **Suspense** boundaries with proper loading fallbacks (`LoadingFallback` component)
- Components are split at route boundaries for optimal bundle size
- Shared components in `components/shared/` for reusability

### 3. Route Detection
- Custom hook `useRouteDetection()` centralizes route detection logic
- Uses `usePathname()` and `useSegments()` from Expo Router
- Type-safe route matching through utility functions
- Route patterns defined in `utils/routeUtils.ts` with `ROUTE_PATTERNS`

### 4. Layout Structure
- Layouts use `Stack` and `Slot` components appropriately
- Responsive layouts handle mobile/tablet/desktop breakpoints
- Breakpoints defined in `constants/responsive.ts`
- Two-pane layouts for large screens, stack navigation for mobile
- Three-pane layout on extra-large screens (>= 1024px)

### 5. Component Organization
- Clear separation of concerns
- Reusable components extracted to `components/shared/`
- Types defined in dedicated `types/` directory
- Utils for business logic in `utils/` directory
- Constants in `constants/` directory

### 6. Type Safety
- Full TypeScript coverage
- Interface definitions for all props
- Type-safe route matching
- Exported types for reuse across components

### 7. Error Handling
- Error boundaries at layout level
- Suspense boundaries with loading states
- Graceful fallbacks for missing data

## Route Structure

```
app/
├── _layout.tsx              # Root layout
├── (chat)/
│   ├── _layout.tsx          # Chat layout (two-pane for large screens)
│   ├── index.tsx            # Conversations list
│   ├── status.tsx           # Status screen
│   └── settings/
│       ├── index.tsx        # Settings main screen
│       ├── appearance.tsx
│       ├── language.tsx
│       └── privacy/
│           └── ...
└── c/
    ├── _layout.tsx          # Conversation layout (three-pane for XL screens)
    └── [id].tsx             # Individual conversation view
```

## Key Utilities & Constants

### `utils/routeUtils.ts`
- Route constants (`ROUTES`)
- Route pattern matching (`ROUTE_PATTERNS`)
- Route matching utilities (`routeMatchers`)
- Type-safe route helpers

### `hooks/useRouteDetection.ts`
- Centralized route detection logic
- Returns typed `RouteDetectionResult` object
- Memoized for performance
- Uses Expo Router hooks properly

### `constants/responsive.ts`
- Breakpoint constants (`BREAKPOINTS`)
- Screen size utilities
- Consistent responsive values across app

### `constants/routes.ts`
- Route constant definitions
- Route builder functions
- Type-safe route generation

### `types/navigation.ts`
- Shared type definitions
- `NavigationItem` interface
- Navigation-related types

### `components/shared/`
- **LoadingFallback.tsx**: Suspense fallback component
- **EmptyState.tsx**: Reusable empty state component

## Performance Optimizations

1. **Memoization**: 
   - Heavy computations memoized with `useMemo`
   - Callbacks memoized with `useCallback`
   - Style objects memoized for theme changes

2. **Code Splitting**: 
   - Settings screen loaded lazily with `React.lazy()`
   - Conversation view loaded lazily
   - Route-based code splitting

3. **Conditional Rendering**: 
   - Components only render when needed
   - Responsive rendering based on screen size
   - Lazy loading with Suspense

4. **Type Safety**: 
   - Full TypeScript coverage
   - Prevents runtime errors
   - Better IDE autocomplete and refactoring

## Responsive Design

- **Mobile (< 768px)**: Stack navigation, single-pane
- **Tablet (768px - 1023px)**: Two-pane layout
- **Desktop (>= 1024px)**: Three-pane layout (conversations + chat + details)

Breakpoints defined in `constants/responsive.ts` for consistency.

## Code Quality Standards

1. **Import Organization**: Grouped by type (Components, Hooks, Utils, Types, Constants)
2. **Component Structure**: Clear prop interfaces, proper TypeScript types
3. **Documentation**: JSDoc comments for complex functions and hooks
4. **Error Handling**: Proper error boundaries and fallbacks
5. **Reusability**: Shared components for common patterns
6. **Maintainability**: Centralized constants and utilities


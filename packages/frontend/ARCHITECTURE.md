# Architecture & Best Practices

This document outlines the architecture and best practices followed in this Expo Router 54 application.

## Expo Router 54 Best Practices

### 1. File-Based Routing
- Routes are defined by the file system structure
- Use route groups `(chat)` for organization without affecting URLs
- Dynamic routes use `[id].tsx` syntax
- Nested routes are created through folder structure

### 2. Code Splitting & Performance
- **React.lazy()** for dynamic imports of heavy components
- **Suspense** boundaries with proper loading fallbacks
- Components are split at route boundaries for optimal bundle size

### 3. Route Detection
- Custom hook `useRouteDetection()` centralizes route detection logic
- Uses `usePathname()` and `useSegments()` from Expo Router
- Type-safe route matching through utility functions

### 4. Layout Structure
- Layouts use `Stack` and `Slot` components appropriately
- Responsive layouts handle mobile/tablet/desktop breakpoints
- Two-pane layouts for large screens, stack navigation for mobile

### 5. Component Organization
- Clear separation of concerns
- Reusable components extracted to shared folders
- Types defined in dedicated `types/` directory
- Utils for business logic in `utils/` directory

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

## Key Utilities

### `utils/routeUtils.ts`
- Route constants (`ROUTES`)
- Route matching utilities
- Specialized route matchers

### `hooks/useRouteDetection.ts`
- Centralized route detection logic
- Returns route state object
- Memoized for performance

### `types/navigation.ts`
- Shared type definitions
- `NavigationItem` interface
- Navigation-related types

## Performance Optimizations

1. **Memoization**: Heavy computations and style objects are memoized
2. **Code Splitting**: Settings screen loaded lazily
3. **Conditional Rendering**: Components only render when needed
4. **Type Safety**: Full TypeScript coverage prevents runtime errors

## Responsive Design

- **Mobile (< 768px)**: Stack navigation
- **Tablet (768px - 1023px)**: Two-pane layout
- **Desktop (>= 1024px)**: Three-pane layout (conversations + chat + details)


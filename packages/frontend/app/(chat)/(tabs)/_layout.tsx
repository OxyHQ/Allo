/**
 * Allo's three pages (chats, updates, calls), side by side under Bloom's tab
 * pager: swiped between on a phone, each kept mounted. Which pages there are is
 * declared once, in `components/navigation/AlloNavigation.tsx`; each needs a
 * route file of that name here.
 */
export { TabPagerLayout as default } from '@oxy.so/bloom/tab-pager/expo-router';

/**
 * Library presets for automatic stable/unstable hook configuration.
 *
 * These presets are auto-detected based on package.json dependencies and applied
 * automatically to reduce configuration burden for common libraries.
 */

/**
 * Configuration for a library preset
 */
export interface LibraryPreset {
  /** Human-readable name of the library */
  name: string;
  /** npm package names that trigger this preset (checks dependencies and devDependencies) */
  packages: string[];
  /** Hooks that return stable references */
  stableHooks: string[];
  /** Hooks that return unstable references (new object each render) */
  unstableHooks: string[];
  /** Regex patterns for hooks that return stable references (e.g., /^use\w+Store$/ for Zustand) */
  stableHookPatterns?: RegExp[];
  /** Regex patterns for hooks that return unstable references */
  unstableHookPatterns?: RegExp[];
  /** Custom function configurations */
  customFunctions?: Record<
    string,
    {
      stable?: boolean;
      deferred?: boolean;
    }
  >;
}

/**
 * Registry of library presets.
 *
 * Each preset defines hooks from popular React libraries and whether they
 * return stable or unstable references.
 *
 * Stability determinations are based on:
 * - Official library documentation
 * - Source code analysis of return value memoization
 * - Community consensus and best practices
 */
export const LIBRARY_PRESETS: LibraryPreset[] = [
  // ============================================
  // Data Fetching Libraries
  // ============================================
  {
    name: 'TanStack Query (React Query)',
    packages: ['@tanstack/react-query', 'react-query'],
    stableHooks: [
      // Core query hooks - return stable object references
      'useQuery',
      'useQueries',
      'useInfiniteQuery',
      'useSuspenseQuery',
      'useSuspenseQueries',
      'useSuspenseInfiniteQuery',
      // Mutation hooks - return stable mutate/mutateAsync functions
      'useMutation',
      // Utility hooks
      'useQueryClient',
      'useIsFetching',
      'useIsMutating',
      'useMutationState',
      'useQueryErrorResetBoundary',
    ],
    unstableHooks: [],
  },
  {
    name: 'SWR',
    packages: ['swr'],
    stableHooks: ['useSWR', 'useSWRInfinite', 'useSWRMutation', 'useSWRImmutable', 'useSWRConfig'],
    unstableHooks: [],
  },
  {
    name: 'Apollo Client',
    packages: ['@apollo/client', 'apollo-client'],
    stableHooks: [
      'useQuery',
      'useLazyQuery',
      'useMutation',
      'useSubscription',
      'useApolloClient',
      'useReactiveVar',
      'useSuspenseQuery',
      'useBackgroundQuery',
      'useReadQuery',
      'useFragment',
    ],
    unstableHooks: [],
  },
  {
    name: 'RTK Query',
    packages: ['@reduxjs/toolkit'],
    stableHooks: [
      // RTK Query hooks (auto-generated)
      'useGetQuery',
      'useLazyGetQuery',
      'usePostMutation',
      'usePutMutation',
      'useDeleteMutation',
      'usePatchMutation',
      // Note: Actual hook names are generated from endpoints
      // Users may need to add their specific endpoint hooks to stableHooks
    ],
    unstableHooks: [],
  },
  {
    name: 'tRPC',
    packages: ['@trpc/react-query', '@trpc/client'],
    stableHooks: [
      // tRPC wraps React Query, inheriting its stability
      'useQuery',
      'useMutation',
      'useInfiniteQuery',
      'useSuspenseQuery',
      'useUtils',
      'useContext',
    ],
    unstableHooks: [],
  },

  // ============================================
  // State Management Libraries
  // ============================================
  {
    name: 'Redux / React-Redux',
    packages: ['react-redux', '@reduxjs/toolkit'],
    stableHooks: [
      'useSelector', // Returns selected state (stable if selector is stable)
      'useDispatch', // Returns stable dispatch function
      'useStore', // Returns stable store reference
    ],
    unstableHooks: [],
  },
  {
    name: 'Zustand',
    packages: ['zustand'],
    stableHooks: [
      // Zustand store hooks return stable references
      'useStore',
      'useShallow', // Shallow comparison helper
      'useStoreWithEqualityFn',
    ],
    unstableHooks: [],
    // Zustand convention: user-defined hooks follow pattern useXxxStore
    // e.g., useAuthStore, useCartStore, useUserStore
    stableHookPatterns: [/^use\w+Store$/],
    customFunctions: {
      // Store.getState() is always stable
      getState: { stable: true },
    },
  },
  {
    name: 'Jotai',
    packages: ['jotai'],
    stableHooks: ['useAtom', 'useAtomValue', 'useSetAtom', 'useStore', 'useHydrateAtoms'],
    unstableHooks: [],
  },
  {
    name: 'Recoil',
    packages: ['recoil'],
    stableHooks: [
      'useRecoilState',
      'useRecoilValue',
      'useSetRecoilState',
      'useResetRecoilState',
      'useRecoilStateLoadable',
      'useRecoilValueLoadable',
      'useRecoilCallback',
      'useRecoilTransaction_UNSTABLE',
      'useRecoilSnapshot',
      'useGotoRecoilSnapshot',
    ],
    unstableHooks: [],
  },
  {
    name: 'Valtio',
    packages: ['valtio'],
    stableHooks: [
      'useSnapshot', // Returns a stable proxy snapshot
      'useProxy',
    ],
    unstableHooks: [],
  },
  {
    name: 'MobX',
    packages: ['mobx-react', 'mobx-react-lite'],
    stableHooks: ['useLocalObservable', 'useObserver', 'useAsObservableSource'],
    unstableHooks: [],
  },
  {
    name: 'XState',
    packages: ['@xstate/react'],
    stableHooks: ['useMachine', 'useActor', 'useInterpret', 'useSelector', 'useSpawn'],
    unstableHooks: [],
  },

  // ============================================
  // Form Libraries
  // ============================================
  {
    name: 'React Hook Form',
    packages: ['react-hook-form'],
    stableHooks: [
      'useForm', // Returns stable form methods
      'useFormContext',
      'useController',
      'useWatch',
      'useFieldArray',
      'useFormState',
    ],
    unstableHooks: [],
  },
  {
    name: 'Formik',
    packages: ['formik'],
    stableHooks: ['useFormik', 'useField', 'useFormikContext'],
    unstableHooks: [],
  },

  // ============================================
  // Routing Libraries
  // ============================================
  {
    name: 'React Router',
    packages: ['react-router', 'react-router-dom'],
    stableHooks: [
      'useNavigate', // Returns stable navigate function
      'useLocation', // Location object is stable per navigation
      'useParams',
      'useSearchParams',
      'useMatch',
      'useMatches',
      'useNavigation',
      'useLoaderData',
      'useActionData',
      'useRouteError',
      'useRouteLoaderData',
      'useFetcher',
      'useFetchers',
      'useRevalidator',
      'useSubmit',
      'useBeforeUnload',
      'useBlocker',
      'useHref',
      'useInRouterContext',
      'useLinkClickHandler',
      'useOutlet',
      'useOutletContext',
      'useResolvedPath',
    ],
    unstableHooks: [],
  },
  {
    name: 'TanStack Router',
    packages: ['@tanstack/react-router'],
    stableHooks: [
      'useRouter',
      'useRouterState',
      'useNavigate',
      'useParams',
      'useSearch',
      'useLoaderData',
      'useMatch',
      'useMatches',
      'useParentMatches',
      'useChildMatches',
      'useLinkProps',
      'useMatchRoute',
      'useBlocker',
    ],
    unstableHooks: [],
  },
  {
    name: 'Expo Router',
    packages: ['expo-router'],
    stableHooks: [
      // Navigation hooks - return stable references
      'useRouter',
      'useNavigation',
      'useNavigationContainerRef',
      'useRootNavigation',
      'useRootNavigationState',
      // Route parameter hooks - return stable objects
      'useLocalSearchParams',
      'useGlobalSearchParams',
      'useSearchParams',
      // Route info hooks
      'useSegments',
      'usePathname',
      'useUnstableGlobalHref',
      // Focus/state hooks
      'useFocusEffect',
      'useIsFocused',
    ],
    unstableHooks: [],
  },

  // ============================================
  // i18n Libraries
  // ============================================
  {
    name: 'react-i18next',
    packages: ['react-i18next'],
    stableHooks: [
      'useTranslation', // Returns stable t function
      'useSSR',
    ],
    unstableHooks: [],
  },
  {
    name: 'react-intl (FormatJS)',
    packages: ['react-intl'],
    stableHooks: [
      'useIntl', // Returns stable intl object
    ],
    unstableHooks: [],
  },

  // ============================================
  // Animation Libraries
  // ============================================
  {
    name: 'Framer Motion',
    packages: ['framer-motion'],
    stableHooks: [
      'useAnimation',
      'useMotionValue',
      'useMotionTemplate',
      'useSpring',
      'useTransform',
      'useViewportScroll',
      'useScroll',
      'useVelocity',
      'useDragControls',
      'useAnimationFrame',
      'useReducedMotion',
      'useInView',
      'usePresence',
      'useIsPresent',
    ],
    unstableHooks: [],
  },
  {
    name: 'React Spring',
    packages: ['react-spring', '@react-spring/web'],
    stableHooks: [
      'useSpring',
      'useSprings',
      'useTrail',
      'useTransition',
      'useChain',
      'useSpringRef',
    ],
    unstableHooks: [],
  },

  // ============================================
  // UI Component Libraries
  // ============================================
  {
    name: 'Chakra UI',
    packages: ['@chakra-ui/react'],
    stableHooks: [
      'useColorMode',
      'useColorModeValue',
      'useDisclosure',
      'useBreakpoint',
      'useBreakpointValue',
      'useMediaQuery',
      'useTheme',
      'useToken',
      'useClipboard',
      'useControllableProp',
      'useControllableState',
      'useDimensions',
      'useBoolean',
      'useConst',
      'useInterval',
      'useMergeRefs',
      'useOutsideClick',
      'usePrevious',
      'useTimeout',
    ],
    unstableHooks: [],
  },
  {
    name: 'Material UI (MUI)',
    packages: ['@mui/material', '@material-ui/core'],
    stableHooks: ['useTheme', 'useMediaQuery', 'useScrollTrigger'],
    unstableHooks: [],
  },
  {
    name: 'Radix UI',
    packages: ['@radix-ui/react-use-controllable-state'],
    stableHooks: ['useControllableState'],
    unstableHooks: [],
  },

  // ============================================
  // Utility Libraries
  // ============================================
  {
    name: 'use-debounce',
    packages: ['use-debounce'],
    stableHooks: ['useDebounce', 'useDebouncedCallback', 'useThrottledCallback'],
    unstableHooks: [],
  },
  {
    name: 'react-use',
    packages: ['react-use'],
    stableHooks: [
      // Most react-use hooks return stable values
      'useAsync',
      'useAsyncFn',
      'useAsyncRetry',
      'useBoolean',
      'useCounter',
      'useDefault',
      'useGetSet',
      'useGetSetState',
      'useLatest',
      'useList',
      'useMap',
      'useMediatedState',
      'useMethods',
      'useNumber',
      'usePrevious',
      'usePreviousDistinct',
      'useQueue',
      'useRafState',
      'useSet',
      'useSetState',
      'useStateList',
      'useToggle',
      'useDebounce',
      'useThrottle',
      'useThrottleFn',
      'useInterval',
      'useTimeout',
      'useTimeoutFn',
      'useLocalStorage',
      'useSessionStorage',
      'useCookie',
    ],
    unstableHooks: [
      // These return new objects each render
      'useMouse',
      'useWindowSize',
      'useWindowScroll',
      'useSize',
      'useMeasure',
      'useScroll',
    ],
  },
  {
    name: 'usehooks-ts',
    packages: ['usehooks-ts'],
    stableHooks: [
      'useBoolean',
      'useCounter',
      'useDebounce',
      'useDebouncedCallback',
      'useEventCallback',
      'useEventListener',
      'useInterval',
      'useIsFirstRender',
      'useLocalStorage',
      'useSessionStorage',
      'useMap',
      'useOnClickOutside',
      'usePrevious',
      'useStep',
      'useTimeout',
      'useToggle',
      'useCopyToClipboard',
      'useDocumentTitle',
      'useIsClient',
      'useIsMounted',
      'useReadLocalStorage',
    ],
    unstableHooks: [
      // These may return new objects
      'useWindowSize',
      'useElementSize',
      'useScreen',
      'useMediaQuery',
      'useHover',
      'useIntersectionObserver',
      'useResizeObserver',
    ],
  },
  {
    name: '@uidotdev/usehooks',
    packages: ['@uidotdev/usehooks'],
    stableHooks: [
      'useBoolean',
      'useCounter',
      'useCopyToClipboard',
      'useDebounce',
      'useDefault',
      'useDocumentTitle',
      'useFavicon',
      'useGeolocation',
      'useHistoryState',
      'useHover',
      'useIdle',
      'useIntersectionObserver',
      'useIsClient',
      'useIsFirstRender',
      'useList',
      'useLockBodyScroll',
      'useLongPress',
      'useMap',
      'useMediaQuery',
      'useMouse',
      'useNetworkState',
      'useObjectState',
      'useOrientation',
      'usePreferredLanguage',
      'usePrevious',
      'useQueue',
      'useRenderCount',
      'useRenderInfo',
      'useScript',
      'useSessionStorage',
      'useSet',
      'useThrottle',
      'useToggle',
      'useVisibilityChange',
      'useWindowScroll',
      'useWindowSize',
      'useLocalStorage',
    ],
    unstableHooks: [],
  },
];

/**
 * Detect which presets apply based on package.json dependencies
 */
export function detectApplicablePresets(dependencies: Record<string, string>): LibraryPreset[] {
  const depNames = new Set(Object.keys(dependencies));
  return LIBRARY_PRESETS.filter((preset) => preset.packages.some((pkg) => depNames.has(pkg)));
}

/**
 * Merge multiple presets into a single configuration
 */
export function mergePresets(presets: LibraryPreset[]): {
  stableHooks: string[];
  unstableHooks: string[];
  stableHookPatterns: RegExp[];
  unstableHookPatterns: RegExp[];
  customFunctions: Record<string, { stable?: boolean; deferred?: boolean }>;
} {
  const stableHooks = new Set<string>();
  const unstableHooks = new Set<string>();
  const stableHookPatterns: RegExp[] = [];
  const unstableHookPatterns: RegExp[] = [];
  const customFunctions: Record<string, { stable?: boolean; deferred?: boolean }> = {};

  for (const preset of presets) {
    for (const hook of preset.stableHooks) {
      stableHooks.add(hook);
    }
    for (const hook of preset.unstableHooks) {
      unstableHooks.add(hook);
    }
    if (preset.stableHookPatterns) {
      stableHookPatterns.push(...preset.stableHookPatterns);
    }
    if (preset.unstableHookPatterns) {
      unstableHookPatterns.push(...preset.unstableHookPatterns);
    }
    if (preset.customFunctions) {
      Object.assign(customFunctions, preset.customFunctions);
    }
  }

  // Remove from stableHooks any that are explicitly in unstableHooks
  // (unstable takes precedence for safety)
  for (const hook of unstableHooks) {
    stableHooks.delete(hook);
  }

  return {
    stableHooks: Array.from(stableHooks),
    unstableHooks: Array.from(unstableHooks),
    stableHookPatterns,
    unstableHookPatterns,
    customFunctions,
  };
}

/**
 * Get the names of detected presets for logging/debugging
 */
export function getDetectedPresetNames(dependencies: Record<string, string>): string[] {
  return detectApplicablePresets(dependencies).map((p) => p.name);
}

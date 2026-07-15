import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { FlatList as RNFlatList, Platform, type FlatListProps, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { LegendList as RL, type LegendListProps, type LegendListRef } from '@legendapp/list/react-native';
import LayoutScrollContext from '@/context/LayoutScrollContext';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * Props accepted by the wrapper: LegendList's props plus the web-only
 * `dataSet` / `onWheel` extras this component forwards.
 */
type LegendListWrapperProps<ItemT> = LegendListProps<ItemT> & {
    dataSet?: Record<string, string>;
    onWheel?: (event: WheelEvent) => void;
};

function LegendListInner<ItemT>(
    props: LegendListWrapperProps<ItemT>,
    ref: React.ForwardedRef<LegendListRef>
) {
    const {
        refreshControl,
        scrollEnabled = true,
        onScroll: propOnScroll,
        scrollEventThrottle: propScrollEventThrottle,
        dataSet,
        onWheel: propOnWheel,
        ...rest
    } = props || {};

    const layoutScroll = useContext(LayoutScrollContext);
    const localRef = useRef<LegendListRef | null>(null);
    const unregisterRef = useRef<(() => void) | null>(null);

    const clearRegistration = useCallback(() => {
        if (unregisterRef.current) {
            unregisterRef.current();
            unregisterRef.current = null;
        }
    }, []);

    const combinedRef = useCallback((node: LegendListRef | null) => {
        localRef.current = node;
        if (typeof ref === 'function') {
            ref(node);
        } else if (ref && typeof ref === 'object') {
            ref.current = node;
        }
    }, [ref]);

    useEffect(() => {
        if (!layoutScroll?.registerScrollable || scrollEnabled === false) {
            clearRegistration();
            return;
        }
        if (localRef.current) {
            unregisterRef.current = layoutScroll.registerScrollable(localRef.current);
        }
        return () => {
            clearRegistration();
        };
    }, [clearRegistration, layoutScroll?.registerScrollable, scrollEnabled]);

    const handleScroll = layoutScroll?.handleScroll;

    const mergedOnScroll = useCallback((event: ScrollEvent) => {
        if (scrollEnabled !== false && handleScroll) {
            handleScroll(event);
        }
        if (typeof propOnScroll === 'function') {
            propOnScroll(event);
        }
    }, [handleScroll, propOnScroll, scrollEnabled]);

    const handleWheelEvent = useCallback((event: WheelEvent) => {
        if (layoutScroll?.forwardWheelEvent) {
            layoutScroll.forwardWheelEvent(event);
        }
        if (typeof propOnWheel === 'function') {
            propOnWheel(event);
        }
    }, [layoutScroll?.forwardWheelEvent, propOnWheel]);

    const effectiveScrollEventThrottle = useMemo(() => {
        if (propScrollEventThrottle != null) return propScrollEventThrottle;
        return layoutScroll?.scrollEventThrottle;
    }, [layoutScroll?.scrollEventThrottle, propScrollEventThrottle]);

    const datasetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return dataSet;
        return { ...(dataSet || {}), layoutscroll: 'true' };
    }, [dataSet]);

    if (RL) {
        const propsForRL: LegendListProps<ItemT> & Record<string, unknown> = {
            recycleItems: true,
            maintainVisibleContentPosition: false,
            ...rest,
            refreshControl,
            scrollEnabled,
            onScroll: layoutScroll ? mergedOnScroll : propOnScroll,
            dataSet: datasetForWeb,
            onWheel: Platform.OS === 'web' ? handleWheelEvent : propOnWheel,
        };

        if (effectiveScrollEventThrottle != null) {
            propsForRL.scrollEventThrottle = effectiveScrollEventThrottle;
        }

        return <RL ref={combinedRef} {...propsForRL} />;
    }

    const fallbackProps: Record<string, unknown> = {
        ...rest,
        refreshControl,
        scrollEnabled,
        onScroll: layoutScroll ? mergedOnScroll : propOnScroll,
        dataSet: datasetForWeb,
        onWheel: Platform.OS === 'web' ? handleWheelEvent : propOnWheel,
    };
    if (effectiveScrollEventThrottle != null) {
        fallbackProps.scrollEventThrottle = effectiveScrollEventThrottle;
    }
    // The wrapper bridges LegendList and FlatList prop shapes; the merged props
    // are structurally a FlatList config at runtime.
    return <RNFlatList {...(fallbackProps as unknown as FlatListProps<ItemT>)} />;
}

const LegendList = React.forwardRef(LegendListInner) as <ItemT>(
    props: LegendListWrapperProps<ItemT> & { ref?: React.ForwardedRef<LegendListRef> }
) => React.ReactElement;

export default LegendList;

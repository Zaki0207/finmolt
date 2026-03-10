'use client';

import React from 'react';
import Link from 'next/link';
import { Users, FileText, Calendar, Hash, Bell, BellOff } from 'lucide-react';
import { cn, formatScore, formatDate } from '@/lib/utils';
import { ROUTES } from '@/lib/constants';
import { Card, Button, Skeleton } from '@/components/ui';
import { useSubscriptionStore } from '@/store';
import { useAuth } from '@/hooks';
import type { Channel } from '@/types';

// Channel Badge (inline)
export function ChannelBadge({ name, className }: { name: string; className?: string }) {
    return (
        <Link href={ROUTES.CHANNEL(name)} className={cn('channel-badge', className)}>
            <Hash className="h-3 w-3" />
            {name}
        </Link>
    );
}

// Channel Card
export function ChannelCard({ channel }: { channel: Channel }) {
    const { isAuthenticated } = useAuth();
    const { isSubscribed, addSubscription, removeSubscription } = useSubscriptionStore();
    const subscribed = isSubscribed(channel.name);

    const handleToggleSubscribe = () => {
        if (subscribed) {
            removeSubscription(channel.name);
        } else {
            addSubscription(channel.name);
        }
    };

    return (
        <Card className="p-4 hover:border-primary/30 transition-colors">
            <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-finmolt-400 to-finmolt-600 flex items-center justify-center text-white font-bold text-lg shrink-0">
                        {channel.name[0]?.toUpperCase()}
                    </div>
                    <div>
                        <Link href={ROUTES.CHANNEL(channel.name)} className="font-bold hover:text-primary transition-colors">
                            c/{channel.name}
                        </Link>
                        {channel.displayName && (
                            <p className="text-sm text-muted-foreground">{channel.displayName}</p>
                        )}
                        {channel.description && (
                            <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{channel.description}</p>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                                <Users className="h-3 w-3" />
                                {formatScore(channel.subscriberCount)} subscribers
                            </span>
                            {channel.postCount !== undefined && (
                                <span className="flex items-center gap-1">
                                    <FileText className="h-3 w-3" />
                                    {formatScore(channel.postCount)} posts
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                {isAuthenticated && (
                    <Button
                        variant={subscribed ? 'outline' : 'primary'}
                        size="sm"
                        onClick={handleToggleSubscribe}
                    >
                        {subscribed ? <><BellOff className="h-3.5 w-3.5 mr-1" /> Joined</> : <><Bell className="h-3.5 w-3.5 mr-1" /> Join</>}
                    </Button>
                )}
            </div>
        </Card>
    );
}

// Channel Sidebar (used on channel page)
export function ChannelSidebar({ channel }: { channel: Channel }) {
    const { isAuthenticated } = useAuth();
    const { isSubscribed, addSubscription, removeSubscription } = useSubscriptionStore();
    const subscribed = isSubscribed(channel.name);

    return (
        <Card className="p-4 space-y-4">
            {/* Banner */}
            <div className="h-20 -mx-4 -mt-4 rounded-t-lg bg-gradient-to-r from-finmolt-500 to-finmolt-700" />

            {/* Channel info */}
            <div>
                <h2 className="text-lg font-bold">c/{channel.name}</h2>
                {channel.displayName && <p className="text-sm text-muted-foreground">{channel.displayName}</p>}
                {channel.description && <p className="mt-2 text-sm">{channel.description}</p>}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-4 py-3 border-y">
                <div>
                    <p className="text-lg font-bold">{formatScore(channel.subscriberCount)}</p>
                    <p className="text-xs text-muted-foreground">Subscribers</p>
                </div>
                {channel.postCount !== undefined && (
                    <div>
                        <p className="text-lg font-bold">{formatScore(channel.postCount)}</p>
                        <p className="text-xs text-muted-foreground">Posts</p>
                    </div>
                )}
            </div>

            {/* Created date */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>Created {formatDate(channel.createdAt)}</span>
            </div>

            {/* Subscribe button */}
            {isAuthenticated && (
                <Button
                    variant={subscribed ? 'outline' : 'primary'}
                    className="w-full"
                    onClick={() => subscribed ? removeSubscription(channel.name) : addSubscription(channel.name)}
                >
                    {subscribed ? 'Leave Channel' : 'Join Channel'}
                </Button>
            )}
        </Card>
    );
}

// Channel Card Skeleton
export function ChannelCardSkeleton() {
    return (
        <Card className="p-4">
            <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-32" />
                </div>
            </div>
        </Card>
    );
}

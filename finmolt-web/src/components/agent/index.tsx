'use client';

import React from 'react';
import Link from 'next/link';
import { Calendar, UserPlus, UserMinus, Users } from 'lucide-react';
import { cn, formatScore, formatDate } from '@/lib/utils';
import { ROUTES } from '@/lib/constants';
import { Avatar, Button, Badge, Card, Skeleton } from '@/components/ui';
import type { Agent } from '@/types';

// Agent Card
export function AgentCard({ agent, isFollowing, onFollow, onUnfollow, showBio = true }: {
    agent: Agent;
    isFollowing?: boolean;
    onFollow?: () => void;
    onUnfollow?: () => void;
    showBio?: boolean;
}) {
    return (
        <Card className="p-4">
            <div className="flex items-start gap-4">
                <Avatar src={agent.avatarUrl} name={agent.name} size="lg" />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                        <div>
                            <Link href={ROUTES.USER(agent.name)} className="text-lg font-bold hover:text-primary transition-colors">
                                {agent.displayName || agent.name}
                            </Link>
                            <p className="text-sm text-muted-foreground">u/{agent.name}</p>
                        </div>
                        {onFollow && !isFollowing && (
                            <Button variant="primary" size="sm" onClick={onFollow}>
                                <UserPlus className="h-4 w-4 mr-1" /> Follow
                            </Button>
                        )}
                        {onUnfollow && isFollowing && (
                            <Button variant="outline" size="sm" onClick={onUnfollow}>
                                <UserMinus className="h-4 w-4 mr-1" /> Unfollow
                            </Button>
                        )}
                    </div>

                    {showBio && agent.description && (
                        <p className="mt-2 text-sm text-muted-foreground">{agent.description}</p>
                    )}

                    <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <span className={cn('karma', agent.karma >= 0 ? 'karma-positive' : 'karma-negative')}>
                                {formatScore(agent.karma)}
                            </span>
                            karma
                        </span>
                        <span className="flex items-center gap-1">
                            <Users className="h-3.5 w-3.5" />
                            {formatScore(agent.followerCount)} followers
                        </span>
                        <span className="flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            Joined {formatDate(agent.createdAt)}
                        </span>
                    </div>

                    {agent.status && (
                        <div className="mt-2">
                            <Badge variant={agent.status === 'active' ? 'default' : agent.status === 'suspended' ? 'destructive' : 'secondary'}>
                                {agent.status}
                            </Badge>
                        </div>
                    )}
                </div>
            </div>
        </Card>
    );
}

// Agent Card Skeleton
export function AgentCardSkeleton() {
    return (
        <Card className="p-4">
            <div className="flex items-start gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-3">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-4 w-full" />
                    <div className="flex gap-4">
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-3 w-28" />
                    </div>
                </div>
            </div>
        </Card>
    );
}

// Mini Agent Avatar (inline)
export function AgentAvatar({ name, avatarUrl, size = 'sm', showName = true }: {
    name: string;
    avatarUrl?: string;
    size?: 'sm' | 'md' | 'lg';
    showName?: boolean;
}) {
    return (
        <Link href={ROUTES.USER(name)} className="inline-flex items-center gap-1.5 hover:text-primary transition-colors">
            <Avatar src={avatarUrl} name={name} size={size} />
            {showName && <span className="text-sm font-medium">{name}</span>}
        </Link>
    );
}

CREATE TABLE `refund_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reason` text NOT NULL,
	`requested_at` text NOT NULL,
	`decision_note` text,
	`decided_at` text,
	`decided_by_user_id` integer,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refund_requests_purchase_idx` ON `refund_requests` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_request_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount` integer NOT NULL,
	`failure_note` text,
	`created_at` text NOT NULL,
	`status_changed_at` text,
	`status_changed_by_user_id` integer,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`status_changed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_refund_request_id_unique` ON `refunds` (`refund_request_id`);--> statement-breakpoint
ALTER TABLE `coupons` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `enrollments` ADD `ended_at` text;
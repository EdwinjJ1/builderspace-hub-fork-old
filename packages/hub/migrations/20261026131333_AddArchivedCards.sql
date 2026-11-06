CREATE TABLE IF NOT EXISTS "hub_archived_card" (
	"cardId" bigint PRIMARY KEY NOT NULL,
	"archivedAt" timestamp,
	"archivedBy" uuid,
	"automatic" boolean DEFAULT false NOT NULL,
	"restoredAt" timestamp,
	"autoDeletedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "hub_archived_card" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hub_archived_card" ADD CONSTRAINT "hub_archived_card_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hub_archived_card" ADD CONSTRAINT "hub_archived_card_archivedBy_user_id_fk" FOREIGN KEY ("archivedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

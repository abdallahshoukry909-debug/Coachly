-- Coachly is now a call tracker only; drop the old coaching-marketplace schema.

drop trigger if exists on_review_inserted on reviews;
drop function if exists update_coach_rating();

drop table if exists reviews;
drop table if exists sessions;
drop table if exists coaches;

alter table profiles drop column if exists role;
alter table profiles drop column if exists bio;

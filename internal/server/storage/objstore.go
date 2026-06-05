package storage

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ObjectStore wraps a minio-go client + bucket. The same code path
// works against MinIO, R2, B2, or AWS S3 — only the endpoint and
// credentials differ.
type ObjectStore struct {
	Client *minio.Client
	Bucket string
	Region string
}

// OpenS3 connects to the configured S3-compatible endpoint and ensures
// the target bucket exists. Idempotent on the bucket creation; safe to
// call on every prosa-server boot.
func OpenS3(ctx context.Context, endpoint, accessKey, secretKey, bucket, region string, useSSL bool) (*ObjectStore, error) {
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
		Region: region,
	})
	if err != nil {
		return nil, fmt.Errorf("init minio client: %w", err)
	}
	store := &ObjectStore{Client: client, Bucket: bucket, Region: region}
	if err := store.ensureBucket(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *ObjectStore) ensureBucket(ctx context.Context) error {
	exists, err := s.Client.BucketExists(ctx, s.Bucket)
	if err != nil {
		return fmt.Errorf("check bucket %s: %w", s.Bucket, err)
	}
	if exists {
		return nil
	}
	if err := s.Client.MakeBucket(ctx, s.Bucket, minio.MakeBucketOptions{Region: s.Region}); err != nil {
		var aerr minio.ErrorResponse
		if errors.As(err, &aerr) && (aerr.Code == "BucketAlreadyOwnedByYou" || aerr.Code == "BucketAlreadyExists") {
			return nil
		}
		return fmt.Errorf("create bucket %s: %w", s.Bucket, err)
	}
	return nil
}

// Put uploads body under key and returns the canonical s3://bucket/key
// URI. Content-type is application/octet-stream since the body is
// arbitrary raw text/binary depending on agent.
func (s *ObjectStore) Put(ctx context.Context, key string, body io.Reader, size int64) (string, error) {
	_, err := s.Client.PutObject(ctx, s.Bucket, key, body, size, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		return "", fmt.Errorf("put object %s: %w", key, err)
	}
	return "s3://" + s.Bucket + "/" + key, nil
}

// Exists reports whether an object is present under key. A "not found"
// response is reported as (false, nil); any other failure (network, auth)
// is returned as an error so callers can distinguish "absent" from
// "couldn't tell".
func (s *ObjectStore) Exists(ctx context.Context, key string) (bool, error) {
	_, err := s.Client.StatObject(ctx, s.Bucket, key, minio.StatObjectOptions{})
	if err != nil {
		if minio.ToErrorResponse(err).Code == "NoSuchKey" {
			return false, nil
		}
		return false, fmt.Errorf("stat object %s: %w", key, err)
	}
	return true, nil
}

// Remove deletes the object under key. Removing a missing key is not an
// error (minio treats DELETE as idempotent).
func (s *ObjectStore) Remove(ctx context.Context, key string) error {
	if err := s.Client.RemoveObject(ctx, s.Bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("remove object %s: %w", key, err)
	}
	return nil
}

// Get fetches an object. The caller MUST close the returned reader.
func (s *ObjectStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.Client.GetObject(ctx, s.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get object %s: %w", key, err)
	}
	return obj, nil
}
